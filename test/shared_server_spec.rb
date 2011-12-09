# encoding: binary
require File.expand_path(File.dirname(__FILE__) + "/spec_helper")

shared_examples_for "A Zangetsu Server" do
	before :all do
		output, error = eval_js!(%Q{
			var TimeEntry = require('zangetsu/time_entry.js');
			console.log(TimeEntry.HEADER_SIZE);
			console.log(TimeEntry.FOOTER_SIZE);
		})
		@header_size, @footer_size = output.split("\n")
		@header_size = @header_size.to_i
		@footer_size = @footer_size.to_i
	end

	after :each do
		@connection.close if @connection
		if @server && !@server.closed?
			@server.close
		end
		@server_socket.close if @server_socket
	end
	
	def handshake(args = {})
		read_json
		write_json(args)
		read_json.should == { 'status' => 'ok' }
	end
	
	describe "handshake" do
		it "works as expected" do
			response = read_json
			response['protocolMajor'].should == 1
			response['protocolMinor'].should == 0
			response['serverName'].should =~ /zangetsu/i
			
			write_json({})
			read_json.should == { 'status' => 'ok' }
		end
	end

	describe "adding" do
		before :each do
			handshake
		end
		
		it "writes to the database asynchronously" do
			key = { :group => 'foo',
			        :timestamp => 48 * 60 * 60}
			command = { :command => 'add',
			        :size => "hello world".size,
			        :opid => 1}
			write_json(key.merge(command))
			@connection.write("hello world")
			
			should_never_happen do
				socket_readable?(@connection)
			end

			should_be_added(key, "hello world")
		end
		
		specify "results can be obtained through the 'results' command" do
			write_json(:command => 'add',
				:group => 'foo',
				:timestamp => 48 * 60 * 60,
				:size => "hello".size,
				:opid => 1)
			@connection.write("hello")
			write_json(:command => 'add',
				:group => 'foo',
				:timestamp => 48 * 60 * 60,
				:size => "world!".size,
				:opid => 2)
			@connection.write("world!")
			
			should_never_happen do
				socket_readable?(@connection)
			end
			
			write_json(:command => 'results')
			read_json.should == {
				"results" => {
					"1" => {
						"status" => "ok",
						"offset" => 0
					},
					"2" => {
						"status" => "ok",
						"offset" => @header_size + "hello".size + @footer_size
					}
				},
				"status" => "ok"
			}

			data_exist?({:group => 'foo', :timestamp => 48 * 60 * 60},
			            ["hello","world!"])
		end
		
		it "complains if an opid is given for which the result isn't yet fetched" do
			write_json(:command => 'add',
				:group => 'foo',
				:timestamp => 48 * 60 * 60,
				:size => "hello".size,
				:opid => 1)
			@connection.write("hello")
			should_never_happen { socket_readable?(@connection) }
			
			write_json(:command => 'add',
				:group => 'foo',
				:timestamp => 48 * 60 * 60,
				:size => "hello".size,
				:opid => 1)
			@connection.write("hello")
			response = read_json
			response["status"].should == "error"
			response["message"].should =~ /opid is already given/
		end
	end
	
	describe "fetching results" do
		before :each do
			handshake
		end
		
		it "clears the result set" do
			write_json(:command => 'add',
				:group => 'foo',
				:timestamp => 48 * 60 * 60,
				:size => "hello".size,
				:opid => 1)
			@connection.write("hello")
			
			write_json(:command => 'results')
			read_json.should == {
				"results" => {
					"1" => {
						"status" => "ok",
						"offset" => 0
					}
				},
				"status" => "ok"
			}
			
			write_json(:command => 'results')
			read_json.should == {
				"results" => {},
				"status"  => "ok"
			}
		end
		
		it "deletes any active opids" do
			write_json(:command => 'add',
				:group => 'foo',
				:timestamp => 48 * 60 * 60,
				:size => "hello".size,
				:opid => 1)
			@connection.write("hello")
			
			write_json(:command => 'results')
			read_json.should == {
				"results" => {
					"1" => {
						"status" => "ok",
						"offset" => 0
					}
				},
				"status" => "ok"
			}
			
			write_json(:command => 'add',
				:group => 'foo',
				:timestamp => 48 * 60 * 60,
				:size => "hello".size,
				:opid => 1)
			@connection.write("hello")
			
			write_json(:command => 'results')
			read_json.should == {
				"results" => {
					"1" => {
						"status" => "ok",
						"offset" => @header_size + "hello".size + @footer_size
					}
				},
				"status" => "ok"
			}
		end
	end
end