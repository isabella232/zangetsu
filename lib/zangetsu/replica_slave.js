/**
 * Represents a connection to a slave server.
 * Implements the logic pertaining replication to a slave server.
 */

var Server    = require('./server.js');
var Constants = require('./constants.js');
var Utils     = require('./utils.js');
var IOUtils   = require('./io_utils.js');
var log       = require('./default_log.js').log;

var getType = Utils.getType;
var readData       = IOUtils.readData;
var readJsonObject = IOUtils.readJsonObject;


// States
const UNINITIALIZED = 0,
      BACKGROUND_SYNCHRONIZING = 1,
      LOCKED_SYNCHRONIZING     = 2,
      READY         = 3,
      DISCONNECTED  = 4;

// Replication command types
const PRUNE_ONE_COMMAND     = 0,
      PRUNE_ALL_COMMAND     = 1,
      FILL_COMMAND          = 2,
      CHECK_RESULTS_COMMAND = 3;


function ReplicaSlave(server, socket, input, output, id) {
	this.server = server;
	this.socket = socket;
	this.input  = input;
	this.output = output;
	this.id     = id;
	this.role   = Constants.ROLE_UNKNOWN;
	this.state  = UNINITIALIZED;
	this.resultCheckThreshold = Constants.DEFAULT_REPLICATION_RESULT_CHECK_THRESHOLD;
	
	this.database = server.database;
	
	return this;
}

ReplicaSlave.prototype._disconnectWithError = function(message) {
	if (this.connected()) {
		this._logError(message);
		IOUtils.disconnectWithError(this.socket, message);
		this.state = DISCONNECTED;
	}
}

ReplicaSlave.prototype._disconnect = function(callback) {
	if (this.connected()) {
		if (this.socket.bufferSize > 0) {
			var self = this;
			this.socket.once('drain', function() {
				self.socket.destroy();
				if (callback) {
					callback();
				}
			});
		} else {
			this.socket.destroy();
			if (callback) {
				process.nextTick(callback);
			}
		}
		this.state = DISCONNECTED;
	} else {
		if (callback) {
			process.nextTick(callback);
		}
	}
}

ReplicaSlave.prototype._log = function(message) {
	var args = ["[ReplicaSlave %d] " + message, this.id];
	for (var i = 1; i < arguments.length; i++) {
		args.push(arguments[i]);
	}
	log.info.apply(log, args);
}

ReplicaSlave.prototype._logDebug = function(message) {
	var args = ["[ReplicaSlave %d] " + message, this.id];
	for (var i = 1; i < arguments.length; i++) {
		args.push(arguments[i]);
	}
	log.debug.apply(log, args);
}

ReplicaSlave.prototype._logError = function(message) {
	var args = ["[ReplicaSlave %d] " + message, this.id];
	for (var i = 1; i < arguments.length; i++) {
		args.push(arguments[i]);
	}
	log.error.apply(log, args);
}

ReplicaSlave.prototype._readJsonObject = function(callback) {
	var self = this;
	readJsonObject(this.input, function(err, object) {
		if (err) {
			if (!err.isIoError) {
				self._disconnectWithError("Invalid JSON data.");
			}
		} else if (self.connected()) {
			if (object) {
				callback(object);
			} else {
				self._disconnect();
			}
		}
	});
}

ReplicaSlave.prototype._write = function(buf, callback) {
	return this.output.write(buf, callback);
}

ReplicaSlave.prototype._writeJSON = function(buf, callback) {
	return this.output.writeJSON(buf, callback);
}

ReplicaSlave.prototype.connected = function() {
	return this.state != DISCONNECTED && !this.socket.destroyed;
}

ReplicaSlave.prototype.ready = function() {
	return this.state == READY;
}

ReplicaSlave.prototype.requestClose = function(callback) {
	this._disconnect(callback);
}

/**
 * Called when a replica slave has connected to this server.
 */
ReplicaSlave.prototype.initialize = function() {
	var reply = { status: 'ok' };
	var self  = this;
	if (this.server.role == Constants.ROLE_MASTER) {
		this.role = Constants.ROLE_SLAVE;
		this._writeJSON({
			status   : 'ok',
			your_role: 'slave',
			my_role  : 'master'
		});
		if (this.connected()) {
			this._startReplication();
		}
	} else {
		console.assert(this.server.role == Constants.ROLE_SLAVE);
		this.role = Constants.ROLE_SLAVE;
		this._writeJSON({
			status     : 'not-master',
			master_host: this.server.masterHostName,
			master_port: this.server.masterPort
		});
	}
}


ReplicaSlave.prototype._startReplication = function() {
	console.assert(this.state == UNINITIALIZED);
	
	/* Ask the member what his table of contents is.
	 * Upon receiving a reply, begin synchronizing.
	 */
	var self = this;
	this._writeJSON({ command: 'getToc' });
	this.state = BACKGROUND_SYNCHRONIZING;
	this._readJsonObject(function(object) {
		self._continueReplication(object);
	});
}

ReplicaSlave.prototype._continueReplication = function(toc) {
	console.assert(this.state == BACKGROUND_SYNCHRONIZING);
	this.toc = toc;
	
	/* Replication consists of three phases.
	 *
	 * Phase 1: The background synchronization phase
	 * (state == BACKGROUND_SYNCHRONIZING). The master synchronizes
	 * the slave's contents with that of the master's. This happens
	 * in the background, i.e. the database is not locked.
	 *
	 * Phase 2: The locked synchronization phase
	 * (state == LOCKED_SYNCHRONIZING). When phase 1 is done there may
	 * still be database modification operations in progress. So the
	 * database is locked and the final changes are synchronized to
	 * the slave, and then the database is unlocked.
	 *
	 * Phase 3: The replication phase (state == READY). The master will
	 * forward all database modifications to the slave.
	 */
	
	var self       = this;
	var database   = this.database;
	/* Contains the replication commands to be sent to the replica, in order. */
	var workQueue  = [];
	/* The workQueue item that's currently being processed. This work item is no
	 * longer contained in the workQueue.
	 */
	var currentWorkItem;
	/* Every time a FILL_COMMAND is put in the workQueue, the resultCheckCounter
	 * is incremented. When it reaches a threshold, a CHECK_RESULTS_COMMAND is
	 * put in the workQueue in order to check the results of the previous
	 * fill commands, and the counter is reset to 0. By checking the results of
	 * multiple fill commands in a single batch we avoid a lot of network
	 * roundtrips.
	 */
	var resultCheckCounter = 0;
	var cleanupHandler;
	var nextOpId = 0;
	
	
	/* The following variable is only meaningful during phase 3.
	 * It indicates whether the replicator is currently started.
	 * Only when it's started will the workQueue be eventually processed.
	 */
	var replicatorStarted = false;
	
	function startReplicator() {
		if (!replicatorStarted
		 && self.state != BACKGROUND_SYNCHRONIZING
		 && self.state != LOCKED_SYNCHRONIZING
		 && self.connected())
		{
			replicatorStarted = true;
			process.nextTick(processNextReplicationCommand);
		}
	}
	
	
	/* Checks in what way the slave differs from the master and schedule
	 * appropriate commands to synchronize the slave with the master.
	 */
	function scheduleSlaveSynchronizationCommands() {
		/* Find groups or time entries that exist on this replica slave but not in
		 * our database, and schedule them for pruning on the replica slave.
		 *
		 * Time entries that are larger on the replica slave than in our database
		 * are also scheduled for pruning.
		 *
		 * Check whether the remaining time entries' sizes on the replica slave
		 * match those in our database, and if not, schedule them for filling.
		 *
		 * We explicitly check against TimeEntry.writtenSize instead of
		 * TimeEntry.dataFileSize because we don't want to replicate data that's
		 * still being written to the filesystem.
		 *
		 * For all TimeEntry objects that are referenced from the workQueue,
		 * we call incReadOperations() on them in order to prevent them from
		 * being closed until they're no longer referenced.
		 */
		
		var groupName, localGroup, groupOnReplica, dst,
			localTimeEntry, timeEntryOnReplica;
		for (groupName in toc) {
			localGroup = database.groups[groupName];
			if (localGroup) {
				groupOnReplica = toc[groupName];
				for (dst in groupOnReplica) {
					dst = parseInt(dst);
					localTimeEntry = localGroup.timeEntries[dst];
					if (localTimeEntry) {
						timeEntryOnReplica = groupOnReplica[dst];
						if (timeEntryOnReplica
						 && localTimeEntry.writtenSize < timeEntryOnReplica.size) {
							self._logDebug("Scheduling refill: %s/%d (%s)",
								groupName, dst,
								"size on master smaller than on slave");
							addToWorkQueue({
								command: PRUNE_ONE_COMMAND,
								groupName: groupName,
								dayTimestamp: dst
							});
							addToWorkQueue({
								command: FILL_COMMAND,
								groupName: groupName,
								dayTimestamp: dst,
								timeEntry: localTimeEntry
							});
							localTimeEntry.incReadOperations();
						}

					} else {
						self._logDebug("Scheduling prune: %s/%d (%s)",
							groupName, dst,
							"time entry doesn't exist on master");
						addToWorkQueue({
							command: PRUNE_ONE_COMMAND,
							groupName: groupName,
							dayTimestamp: dst
						});
					}
				}

			} else {
				self._logDebug("Scheduling prune: %s (%s)",
					groupName,
					"group doesn't exist on master");
				addToWorkQueue({
					command: PRUNE_ONE_COMMAND,
					groupName: groupName
				});
			}
		}
		for (groupName in database.groups) {
			localGroup = database.groups[groupName];
			groupOnReplica = toc[groupName];

			for (dst in localGroup.timeEntries) {
				dst = parseInt(dst);
				localTimeEntry = localGroup.timeEntries[dst];
				if (groupOnReplica) {
					timeEntryOnReplica = groupOnReplica[dst];
				} else {
					timeEntryOnReplica = undefined;
				}

				if (timeEntryOnReplica) {
					if (localTimeEntry.writtenSize > timeEntryOnReplica.size) {
						self._logDebug("Scheduling fill: %s/%d (%s)",
							groupName, dst,
							"size on master larger than on slave");
						addToWorkQueue({
							command: FILL_COMMAND,
							groupName: groupName,
							dayTimestamp: dst,
							timeEntry: localTimeEntry
						});
						localTimeEntry.incReadOperations();
					}
				} else {
					if (localTimeEntry.writtenSize > 0) {
						self._logDebug("Scheduling fill: %s/%d (%s)",
							groupName, dst,
							"time entry doesn't exist on slave");
						addToWorkQueue({
							command: FILL_COMMAND,
							groupName: groupName,
							dayTimestamp: dst,
							timeEntry: localTimeEntry
						});
						localTimeEntry.incReadOperations();
					}
				}
			}
		}
	}
	
	
	/*************** Replication protocol event handlers ***************/
	
	/* Main entry point for the replicator (processing scheduled work items). */
	function processNextReplicationCommand() {
		if (!self.connected()) {
			return;
		}
		
		var details = workQueue.shift();
		if (details) {
			currentWorkItem = details;
			switch (details.command) {
			case PRUNE_ONE_COMMAND:
				delete details.command;
				pruneOne(details);
				break;
			case PRUNE_ALL_COMMAND:
				delete details.command;
				pruneAll(details);
				break;
			case FILL_COMMAND:
				delete details.command;
				fill(details);
				break;
			case CHECK_RESULTS_COMMAND:
				delete details.command;
				checkResults(details);
				break;
			default:
				console.assert(false);
			}
			
		} else if (self.state == BACKGROUND_SYNCHRONIZING) {
			console.assert(!replicatorStarted);
			currentWorkItem = undefined;
			
			self._log("Background synchronization almost done; checking concurrent modifications");
			scheduleSlaveSynchronizationCommands();
			if (workQueue.length > 0) {
				self._log("Restarting background synchronization because of concurrent modifications");
				processNextReplicationCommand();
			} else {
				self._log("Background synchronization done");
				doneBackgroundSynchronizing();
			}
		
		} else if (self.state == LOCKED_SYNCHRONIZING) {
			console.assert(!replicatorStarted);
			currentWorkItem = undefined;
			
			// Extra bug check.
			scheduleSlaveSynchronizationCommands();
			console.assert(workQueue.length == 0);
			
			self._log("Locked synchronization done");
			doneLockedSynchronizing();
			
		} else {
			console.assert(self.state == READY);
			console.assert(replicatorStarted);
			currentWorkItem = undefined;
			replicatorStarted = false;
		}
	}
	
	function addToWorkQueue(item, callback) {
		var checkResultsCommandAdded = false;
		workQueue.push(item);
		/* After every 'resultCheckThreshold' fill commands we
		 * will want to check their results. The code here
		 * only deals with fill commands that have data buffers
		 * (i.e. fill commands that work through file streaming).
		 * Checking the results of fill commands that don't have
		 * data buffers is handled in fillByStreamingDataFile().
		 */
		if (item.command == FILL_COMMAND && item.dataBuffers) {
			resultCheckCounter++;
			if (resultCheckCounter >= self.resultCheckThreshold) {
				resultCheckCounter = 0;
				checkResultsCommandAdded = true;
				workQueue.push({
					command: CHECK_RESULTS_COMMAND,
					callback: callback
				});
			}
		}
		if (!checkResultsCommandAdded) {
			workQueue[workQueue.length - 1].callback = callback;
		}
	}

	function cleanupWorkItem(details) {
		if (!details.cleaned) {
			details.cleaned = true;
			if (details.command == FILL_COMMAND) {
				details.timeEntry.decReadOperations();
			}
			if (details.callback) {
				details.callback();
			}
		}
	}
	
	function cleanupWorkQueue() {
		var queue = workQueue;
		workQueue = [];
		var currentItem = currentWorkItem;
		currentWorkItem = undefined;
		
		for (var i = 0; i < queue.length; i++) {
			cleanupWorkItem(queue[i]);
		}
		if (currentItem) {
			cleanupWorkItem(currentItem);
		}
	}
	
	
	function pruneAll(details) {
		self._logDebug("Pruning all: %j", details);
		
		var groupOnReplica = toc[details.group];
		if (groupOnReplica) {
			var dayTimestampsToPrune = [];
			var dst, i;
			for (dst in groupOnReplica) {
				dst = parseInt(dst);
				if (dst < details.dayTimestamp) {
					dayTimestampsToPrune.push(dst);
				}
			}
			for (i = 0; i < dayTimestampsToPrune.length; i++) {
				dst = dayTimestampsToPrune[i];
				delete groupOnReplica[dst];
			}
			
			pruneNextTimestamp(details, dayTimestampsToPrune);
		} else {
			cleanupWorkItem(details);
			processNextReplicationCommand();
		}
	}
	
	function pruneNextTimestamp(details, dayTimestampsToPrune) {
		var dst = dayTimestampsToPrune.pop();
		if (dst !== undefined) {
			var message = {
				command: 'removeOne',
				group: details.group,
				dayTimestamp: dst
			};
			self._writeJSON(message, function(err) {
				sentRemoveOneCommand(err, details, dayTimestampsToPrune);
			});
		} else {
			cleanupWorkItem(details);
			processNextReplicationCommand();
		}
	}
	
	function sentRemoveOneCommand(err, details, dayTimestampsToPrune) {
		if (self.connected() && !err) {
			self._readJsonObject(function(object) {
				receivedReplyForRemoveOneCommand(object, details,
					dayTimestampsToPrune);
			});
		}
	}
	
	function receivedReplyForRemoveOneCommand(reply, details, dayTimestampsToPrune) {
		if (reply.status == 'ok') {
			pruneNextTimestamp(details, dayTimestampsToPrune);
		} else {
			self._logError("Non-ok reply for 'removeOne' command: " +
				JSON.stringify(reply));
			self._disconnect();
		}
	}
	
	
	function pruneOne(details) {
		self._logDebug("Pruning one: %j", details);
		
		var groupOnReplica = toc[details.groupName];
		console.assert(groupOnReplica !== undefined);
		var message;
		
		if (details.dayTimestamp !== undefined) {
			message = {
				command: 'removeOne',
				group: details.groupName,
				dayTimestamp: details.dayTimestamp
			};
			console.assert(groupOnReplica[details.dayTimestamp] !== undefined);
			delete groupOnReplica[details.dayTimestamp];
		} else {
			message = {
				command: 'remove',
				group: details.groupName
			};
			delete toc[details.groupName];
		}
		self._writeJSON(message, function(err) {
			sentRemoveCommand(err, details);
		});
	}
	
	function sentRemoveCommand(err, details) {
		if (self.connected() && !err) {
			self._readJsonObject(function(object) {
				receivedReplyForRemoveCommand(object, details);
			});
		}
	}
	
	function receivedReplyForRemoveCommand(reply, details) {
		if (reply.status == 'ok') {
			cleanupWorkItem(details);
			processNextReplicationCommand();
		} else {
			self._logError("Non-ok reply for 'remove' command: " + JSON.stringify(reply));
			self._disconnect();
		}
	}
	
	
	function fill(details) {
		if (details.dataBuffers) {
			self._logDebug("Fill (with buffers): %j", {
				groupName: details.groupName,
				dayTimestamp: details.dayTimestamp
			});
		} else {
			self._logDebug("Fill (with streaming): %j", {
				groupName: details.groupName,
				dayTimestamp: details.dayTimestamp
			});
		}
		
		var groupOnReplica = toc[details.groupName];
		if (!groupOnReplica) {
			groupOnReplica = toc[details.groupName] = {};
		}
		details.timeEntryOnReplica = groupOnReplica[details.dayTimestamp];
		if (!details.timeEntryOnReplica) {
			details.timeEntryOnReplica = groupOnReplica[details.dayTimestamp] = { size: 0 };
		}
		
		if (details.dataBuffers) {
			console.assert(self.state == READY);
			fillBySendingBuffers(details);
		} else {
			console.assert(self.state == BACKGROUND_SYNCHRONIZING
				|| self.state == LOCKED_SYNCHRONIZING);
			fillByStreamingDataFile(details);
		}
	}
	
	function fillBySendingBuffers(details) {
		console.assert(self.state == READY);
		
		var i, totalDataSize = 0;
		for (i = 0; i < details.dataBuffers.length; i++) {
			totalDataSize += details.dataBuffers[i].length;
		}

		function written() {
			details.timeEntryOnReplica.size += details.size;
			cleanupWorkItem(details);
			processNextReplicationCommand();
		}
		
		var message = {
			command: 'add',
			group: details.groupName,
			timestamp: details.dayTimestamp * 24 * 60 * 60,
			size: totalDataSize,
			opid: nextOpId
		};
		nextOpId++;
		self._writeJSON(message,
			details.dataBuffers.length == 0 ? written : undefined);
		for (i = 0; i < details.dataBuffers.length; i++) {
			self._write(details.dataBuffers[i],
				i == details.dataBuffers.length - 1 ? written : undefined);
		}
	}

	function fillByStreamingDataFile(details) {
		details.timeEntry.get(details.timeEntryOnReplica.size, function(err, record) {
			if (!self.connected()) {
				return;
			}
			if (err) {
				self._logDebug("Could not read time entry %s/%d offset %d (local read error: '%s'); " +
					"suspecting that the replica's data file is corrupted, refilling it",
					details.groupName,
					details.dayTimestamp,
					details.timeEntryOnReplica.size,
					err.message);
				var message = {
					command: 'removeOne',
					group: details.groupName,
					dayTimestamp: details.dayTimestamp
				};
				self._writeJSON(message);
				self._readJsonObject(function(reply) {
					if (reply.status == 'ok') {
						details.timeEntryOnReplica.size = 0;
						startStreamingDataFile(details);
					} else {
						self._logError("Non-ok reply for 'removeOne' command: %j", reply);
						self._disconnect();
					}
				});
			} else {
				startStreamingDataFile(details);
			}
		});
	}

	function startStreamingDataFile(details) {
		console.assert(self.state == BACKGROUND_SYNCHRONIZING
			|| self.state == LOCKED_SYNCHRONIZING);
		var progress = details.timeEntryOnReplica.size;

		details.timeEntry.each(details.timeEntryOnReplica.size,
			function(err, record)
		{
			if (record) {
				progress += record.recordSize;
			}
			if (!self.connected()) {
				if (record) {
					record.stop();
				}
			} else if (err) {
				self._disconnectWithError("Cannot read data file on master: " +
					err.message);
			} else if (!record.eof) {
				var message = {
					command: 'add',
					group: details.groupName,
					timestamp: details.dayTimestamp * 24 * 60 * 60,
					size: record.dataSize,
					opid: nextOpId,
					corrupted: record.corrupted
				};
				
				nextOpId++;
				details.timeEntryOnReplica.size += record.recordSize;
				cleanupHandler = record.stop;

				self._writeJSON(message);
				self._write(record.data, function(err) {
					dataFileRecordSent(err, details, progress, record);
				});
			} else if (resultCheckCounter == 0) {
				/* Upon EOF, if the last command sent to the slave is a 'results'
				 * command, then immediately go to processing the next replication
				 * command in the queue. Otherwise, send a 'results' command first,
				 * and continue with processing the next replication command after
				 * the 'results' command has been acknowledged.
				 */
				cleanupWorkItem(details);
				processNextReplicationCommand();
			} else {
				resultCheckCounter = 0;
				self._logDebug("Streamed %s/%s MB (%s); check results",
					(details.timeEntry.dataFileSize / 1024 / 1024).toFixed(1),
					(details.timeEntry.dataFileSize / 1024 / 1024).toFixed(1),
					'100.0%');
				self._writeJSON({ command: 'results' }, function(err) {
					if (!err && self.connected()) {
						self._readJsonObject(function(object) {
							dataFileFullyStreamed(object, details);
						});
					}
				});
			}
		});
	}

	function dataFileRecordSent(err, details, progress, record) {
		if (!self.connected() || err) {
			if (record) {
				record.stop();
			}
			return;
		}

		resultCheckCounter++;
		if (resultCheckCounter >= self.resultCheckThreshold) {
			resultCheckCounter = 0;
			self._logDebug("Streamed %s/%s MB (%s); check results",
				(progress / 1024 / 1024).toFixed(1),
				(details.timeEntry.dataFileSize / 1024 / 1024).toFixed(1),
				(progress / details.timeEntry.dataFileSize * 100).toFixed(1) + '%');
			self._writeJSON({ command: 'results' }, function(err) {
				if (err || !self.connected()) {
					if (record) {
						stop();
					}
				} else {
					self._readJsonObject(function(object) {
						handleCheckResultAfterSendingDataFileRecord(
							object, details, record);
					});
				}
			});
		} else {
			continueReading();
		}
	}

	function handleCheckResultAfterSendingDataFileRecord(reply, details, record) {
		cleanupHandler = undefined;
		if (reply.status == 'ok') {
			nextOpId = 0;
			record.readNext();
		} else {
			self._logError("Non-ok reply for 'results' command: %j", reply);
			self._disconnect();
			record.stop();
		}
	}

	function dataFileFullyStreamed(reply, details) {
		if (reply.status == 'ok') {
			nextOpId = 0;
			cleanupWorkItem(details);
			processNextReplicationCommand();
		} else {
			self._logError("Non-ok reply for 'results' command: %j", reply);
			self._disconnect();
		}
	}
	

	function checkResults(details) {
		self._logDebug("Check results");
		self._writeJSON({ command: 'results' }, function(err) {
			if (!err && self.connected()) {
				self._readJsonObject(function(object) {
					handleCheckResult(object, details);
				});
			}
		});
	}

	function handleCheckResult(reply, details) {
		if (reply.status == 'ok') {
			nextOpId = 0;
			cleanupWorkItem(details);
			processNextReplicationCommand();
		} else {
			self._logError("Non-ok reply for 'results' command: %j", reply);
			self._disconnect();
		}
	}
	
	
	/*************** Database and connection event handlers ***************/
	
	function onAddingToOurDatabase(localTimeEntry, groupName, dayTimestamp, dataBuffers, done) {
		if (!self.connected()) {
			done();
			return;
		}
		console.assert(self.state != LOCKED_SYNCHRONIZING);
		if (self.state == READY) {
			localTimeEntry.incReadOperations();
			self._logDebug("Scheduling fill: %s/%d", groupName, dayTimestamp);
			addToWorkQueue({
				command: FILL_COMMAND,
				groupName: groupName,
				dayTimestamp: dayTimestamp,
				timeEntry: localTimeEntry,
				dataBuffers: dataBuffers,
				size: database.calculateRecordSize(dataBuffers)
			}, done);
			startReplicator();
		} else {
			done();
		}
	}
	
	function onRemoveFromOurDatabase(groupName, dayTimestamp) {
		if (!self.connected()) {
			return;
		}
		console.assert(self.state != LOCKED_SYNCHRONIZING);
		if (self.state == READY) {
			if (dayTimestamp) {
				self._logDebug("Scheduling prune: %s/%d",
					groupName, dayTimestamp);
				addToWorkQueue({
					command: PRUNE_ALL_COMMAND,
					group: groupName,
					dayTimestamp: dayTimestamp
				});
			} else {
				self._logDebug("Scheduling prune:", groupName);
				addToWorkQueue({
					command: PRUNE_ONE_COMMAND,
					group: groupName
				});
			}
			startReplicator();
		}
	}
	
	function onConnectionClose() {
		database.removeListener('adding', onAddingToOurDatabase);
		database.removeListener('remove', onRemoveFromOurDatabase);
		if (cleanupHandler) {
			// Stop TimeEntry.each() call and decrease TimeEntry
			// read operations counter.
			var handler = cleanupHandler;
			cleanupHandler = undefined;
			handler();
		}
		cleanupWorkQueue();
	}
	
	
	/*********************************************/
	
	function doneBackgroundSynchronizing() {
		console.assert(workQueue.length == 0);
		console.assert(self.onJSON === undefined);
		console.assert(currentWorkItem === undefined);
		self._log("Switching to locked synchronization phase");
		self.state = LOCKED_SYNCHRONIZING;
		database.lock(function() {
			console.assert(workQueue.length == 0);
			scheduleSlaveSynchronizationCommands();
			processNextReplicationCommand();
		});
	}
	
	function doneLockedSynchronizing() {
		console.assert(workQueue.length == 0);
		console.assert(self.onJSON === undefined);
		console.assert(currentWorkItem === undefined);
		self._log("Done synchronizing; pinging replica slave");
		
		self._writeJSON({ command: 'ping' });
		self._readJsonObject(function(reply) {
			self._log("Replica slave responded and is now READY");
			self.state = READY;
			database.on('adding', onAddingToOurDatabase);
			database.on('remove', onRemoveFromOurDatabase);
			database.unlock();

			self.input.resume();
			self.input.onData = function(data) {
				return data.length;
			}
			self.input.onEnd = function() {
				self.socket.destroySoon();
			}
		});
	}
	
	this.socket.on('close', onConnectionClose);
	scheduleSlaveSynchronizationCommands();
	processNextReplicationCommand();
}


exports.ReplicaSlave = ReplicaSlave;
exports.READY = READY;
exports.DISCONNECTED = DISCONNECTED;
