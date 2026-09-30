/*
 * Run the browser QUnit suite (test/index.html) headlessly in Chrome via puppeteer.
 *
 * Upstream ran this suite in real browsers through TestSwarm; this runner lets CI
 * run it headlessly after `grunt` has built dist/.
 *
 * Requires a modern node (>= 18) and puppeteer, which is intentionally NOT a
 * devDependency (the build itself runs on node 0.10). Install it separately and
 * point NODE_PATH at it, e.g.:
 *
 *   mkdir -p /tmp/qunit-runner && cd /tmp/qunit-runner &&
 *     npm install --no-save --registry=https://registry.npmjs.org/ puppeteer@22.15.0
 *   NODE_PATH=/tmp/qunit-runner/node_modules node test/run-qunit-headless.cjs
 *
 * The .cjs extension keeps this modern-node script out of grunt's jshint glob
 * for the test/ directory (which only matches .js files).
 *
 * The repo root is served with PHP's built-in server so the ajax tests can
 * execute test/data/*.php. Environment:
 *   PHP_BIN          php binary to use (default "php")
 *   QUNIT_PORT       port for the php server (default 8910)
 *   QUNIT_NO_SERVER  set to "1" to use an already running server on QUNIT_PORT
 *   QUNIT_QUERY      extra query string for test/index.html (e.g. "dev" or "module=ajax")
 *   QUNIT_TIMEOUT    overall timeout in minutes (default 20)
 *   QUNIT_VERBOSE    set to "1" to also print every passing test and every php request
 *
 * Progress is printed continuously (one line per finished module, every failing
 * test as it finishes, and a heartbeat while a test runs long). Exits non-zero if
 * any test failed, no test started within 60s of page load, no test finished for
 * 3 minutes (QUnit's own per-test timeout is 20s, so the queue is stuck), or the
 * overall timeout was reached.
 */
"use strict";

const path = require( "path" );
const http = require( "http" );
const { spawn } = require( "child_process" );
const puppeteer = require( "puppeteer" );

// This script lives in test/; the repo root is its parent
const root = path.resolve( __dirname, ".." );
const port = parseInt( process.env.QUNIT_PORT || "8910", 10 );
const timeoutMs = parseFloat( process.env.QUNIT_TIMEOUT || "20" ) * 60 * 1000;
const query = process.env.QUNIT_QUERY ? "?" + process.env.QUNIT_QUERY : "";
const url = "http://127.0.0.1:" + port + "/test/index.html" + query;
const verbose = process.env.QUNIT_VERBOSE === "1";

const START_TIMEOUT_MS = 60 * 1000;
const STALL_TIMEOUT_MS = 3 * 60 * 1000;
const HEARTBEAT_MS = 30 * 1000;
const POLL_MS = 1000;

function log( line ) {
	console.log( line );
}

function waitForServer( deadline ) {
	return new Promise( ( resolve, reject ) => {
		( function attempt() {
			const req = http.get( "http://127.0.0.1:" + port + "/test/index.html", ( res ) => {
				res.resume();
				resolve( res.statusCode );
			} );
			req.on( "error", () => {
				if ( Date.now() > deadline ) {
					reject( new Error( "php server did not come up on port " + port ) );
				} else {
					setTimeout( attempt, 200 );
				}
			} );
		} )();
	} );
}

// Runs in the page before any script: hooks QUnit's callbacks the moment
// test/libs/qunit/qunit.js assigns window.QUnit (top window only; iframes
// used by the tests reuse parent.QUnit or load their own copies).
function installHooks() {
	if ( window !== window.top ) {
		return;
	}
	const results = window.__qunitHeadless = {
		done: false, started: false, tests: [], modules: [], summary: null, current: null
	};
	let qunit;
	Object.defineProperty( window, "QUnit", {
		configurable: true,
		get: function() {
			return qunit;
		},
		set: function( value ) {
			qunit = value;
			if ( !value || value.__headlessHooked ) {
				return;
			}
			value.__headlessHooked = true;

			// QUnit 1.14 runs QUnit.load both from test/data/testinit.js (once all
			// unit files are loaded) and on window "load"; the second call rebuilds
			// the #qunit-tests list. If window "load" fires after tests started (a
			// slow CI machine), the running test's result <li> is gone, QUnit throws
			// "Cannot set properties of null (setting 'className')" and the queue
			// stops. Defer the initial QUnit.start() until the page has loaded (our
			// listener runs after QUnit's own load handler).
			const originalStart = value.start;
			value.start = function() {
				const self = this;
				const args = arguments;
				if ( document.readyState !== "complete" ) {
					window.addEventListener( "load", function() {
						originalStart.apply( self, args );
					} );
					return;
				}
				return originalStart.apply( self, args );
			};

			value.testStart( function( details ) {
				results.started = true;
				results.current = {
					module: details.module, name: details.name, assertions: [], startedAt: Date.now()
				};
			} );
			value.log( function( details ) {
				if ( !details.result && results.current ) {
					let message = details.message || "(no message)";
					if ( "expected" in details ) {
						message += " | expected: " + value.jsDump.parse( details.expected ) +
							" | actual: " + value.jsDump.parse( details.actual );
					}
					if ( details.source ) {
						message += "\n        " + String( details.source ).split( "\n" )[ 0 ].trim();
					}
					results.current.assertions.push( message );
				}
			} );
			value.testDone( function( details ) {
				results.tests.push( {
					module: details.module,
					name: details.name,
					failed: details.failed,
					passed: details.passed,
					total: details.total,
					messages: results.current ? results.current.assertions : []
				} );
				results.current = null;
			} );
			value.moduleDone( function( details ) {
				results.modules.push( {
					name: details.name, failed: details.failed, total: details.total,
					testsEnd: results.tests.length
				} );
			} );
			value.done( function( details ) {
				results.summary = details;
				results.done = true;
			} );
		}
	} );
}

function formatFailure( test ) {
	const lines = [ "  FAIL " + test.module + " :: " + test.name +
		" (" + test.failed + " of " + test.total + " assertions failed)" ];
	test.messages.forEach( ( msg ) => lines.push( "      - " + msg ) );
	return lines.join( "\n" );
}

async function dumpPage( page, diagnostics ) {
	log( "---- page diagnostics ----" );
	try {
		const info = await page.evaluate( () => ( {
			title: document.title,
			readyState: document.readyState,
			qunitDefined: typeof window.QUnit !== "undefined",
			html: document.body ? document.body.innerHTML.slice( 0, 2000 ) : "(no body)",
			text: document.body ? document.body.innerText.slice( 0, 2000 ) : "(no body)"
		} ) );
		log( "document.title: " + info.title );
		log( "document.readyState: " + info.readyState + "; QUnit defined: " + info.qunitDefined );
		log( "body text (first 2000 chars):\n" + info.text );
		log( "body innerHTML (first 2000 chars):\n" + info.html );
	} catch ( err ) {
		log( "could not inspect page: " + err.message );
	}
	log( "page errors: " + ( diagnostics.pageErrors.length ?
		"\n  " + diagnostics.pageErrors.join( "\n  " ) : "none" ) );
	log( "failed requests / HTTP >= 400: " + ( diagnostics.badRequests.length ?
		"\n  " + diagnostics.badRequests.join( "\n  " ) : "none" ) );
	log( "---- end page diagnostics ----" );
}

async function main() {
	let server = null;
	let browser = null;
	let exitCode = 1;
	const deadline = Date.now() + timeoutMs;
	const diagnostics = { pageErrors: [], badRequests: [] };

	try {
		if ( process.env.QUNIT_NO_SERVER !== "1" ) {
			const phpBin = process.env.PHP_BIN || "php";
			log( "Starting " + phpBin + " -S 127.0.0.1:" + port + " -t " + root );
			server = spawn( phpBin,
				[ "-S", "127.0.0.1:" + port, "-t", root ],
				{
					cwd: root,
					stdio: [ "ignore", "pipe", "pipe" ],

					// Some ajax tests keep requests open (sleep/abort); serve concurrently
					env: Object.assign( { PHP_CLI_SERVER_WORKERS: "4" }, process.env )
				} );
			server.on( "error", ( err ) => log( "[php] failed to start: " + err.message ) );
			const relay = ( chunk ) => {
				String( chunk ).split( "\n" ).forEach( ( line ) => {
					if ( !line.trim() ) {
						return;
					}

					// The built-in server logs every connection and request; keep the
					// CI log readable by printing only startup lines, errors/notices and
					// 4xx/5xx responses (the suite requests some missing files on purpose)
					if ( verbose || !/ (Accepted|Closing)$| \[[23]\d\d\]: /.test( line ) ) {
						log( "[php] " + line );
					}
				} );
			};
			server.stdout.on( "data", relay );
			server.stderr.on( "data", relay );
			server.on( "exit", ( code, signal ) => {
				if ( code || ( signal && signal !== "SIGTERM" ) ) {
					log( "[php] server exited with " + ( code !== null ? "code " + code : signal ) );
				}
			} );
		}
		const status = await waitForServer( Date.now() + 15000 );
		log( "Server up; GET /test/index.html -> HTTP " + status );

		browser = await puppeteer.launch( {
			headless: true,
			args: [
				"--no-sandbox",
				"--disable-dev-shm-usage",

				// Chrome 117+ is phasing out the unload event; the suite relies on it
				// (e.g. data #10080 navigates an iframe and waits for "unload")
				"--disable-features=DeprecateUnload,DeprecateUnloadByAllowList",

				// Keep timers (effects/animation tests) running at full speed
				"--disable-background-timer-throttling",
				"--disable-renderer-backgrounding",
				"--disable-backgrounding-occluded-windows"
			]
		} );
		log( "Browser: " + await browser.version() );
		const page = await browser.newPage();
		await page.setViewport( { width: 1280, height: 1024 } );
		page.on( "pageerror", ( err ) => {
			diagnostics.pageErrors.push( err.message );
			log( "[page error] " + err.message );
		} );
		page.on( "requestfailed", ( req ) => {
			const failure = req.failure();
			const line = "request failed: " + req.method() + " " + req.url() +
				" (" + ( failure ? failure.errorText : "unknown" ) + ")";
			diagnostics.badRequests.push( line );
			if ( verbose ) {
				log( "[page] " + line );
			}
		} );
		page.on( "response", ( res ) => {
			if ( res.status() >= 400 ) {
				diagnostics.badRequests.push( "HTTP " + res.status() + ": " +
					res.request().method() + " " + res.url() );
			}
		} );
		page.on( "dialog", ( dialog ) => dialog.dismiss() );
		await page.evaluateOnNewDocument( installHooks );

		log( "Opening " + url );
		await page.goto( url, { waitUntil: "load", timeout: 120000 } );
		const loadedAt = Date.now();
		log( "Page loaded; waiting for QUnit" );

		let printedTests = 0;
		let printedModules = 0;
		let moduleTestsStart = 0;
		let lastProgressAt = Date.now();
		let lastHeartbeatAt = Date.now();
		let failure = null;
		let results;
		for ( ;; ) {
			results = await page.evaluate( () => window.__qunitHeadless || null );
			const now = Date.now();
			if ( !results ) {
				failure = "QUnit hooks were not installed (test/libs/qunit/qunit.js did not load?)";
				break;
			}

			for ( ; printedTests < results.tests.length; printedTests++ ) {
				const test = results.tests[ printedTests ];
				if ( test.failed ) {
					log( formatFailure( test ) );
				} else if ( verbose ) {
					log( "  ok " + test.module + " :: " + test.name );
				}
				lastProgressAt = now;
			}
			for ( ; printedModules < results.modules.length; printedModules++ ) {
				const m = results.modules[ printedModules ];
				const moduleTests = results.tests.slice( moduleTestsStart, m.testsEnd );
				const moduleFailed = moduleTests.filter( ( test ) => test.failed ).length;
				log( "module " + m.name + ": " + moduleTests.length + " tests, " +
					( moduleTests.length - moduleFailed ) + " passed, " + moduleFailed + " failed (" +
					m.total + " assertions, " + m.failed + " failed; " + m.testsEnd +
					" tests finished overall)" );
				moduleTestsStart = m.testsEnd;
			}

			if ( results.done ) {
				break;
			}
			if ( !results.started && now - loadedAt > START_TIMEOUT_MS ) {
				failure = "QUnit did not start any test within " + ( START_TIMEOUT_MS / 1000 ) +
					"s of page load";
				break;
			}
			if ( results.started && now - lastProgressAt > STALL_TIMEOUT_MS ) {
				failure = "no test finished for " + ( STALL_TIMEOUT_MS / 1000 ) + "s; QUnit is stuck" +
					( results.current ? " in " + results.current.module + " :: " +
						results.current.name : "" );
				break;
			}
			if ( now > deadline ) {
				failure = "QUnit did not finish within " + ( timeoutMs / 60000 ) + " minutes" +
					( results.current ? "; stuck in " + results.current.module + " :: " +
						results.current.name : "" );
				break;
			}
			if ( now - lastHeartbeatAt > HEARTBEAT_MS ) {
				log( "... " + printedTests + " tests finished" + ( results.current ?
					"; running " + results.current.module + " :: " + results.current.name +
					" for " + Math.round( ( now - results.current.startedAt ) / 1000 ) + "s" : "" ) );
				lastHeartbeatAt = now;
			}
			await new Promise( ( resolve ) => setTimeout( resolve, POLL_MS ) );
		}

		if ( failure ) {
			log( "ERROR: " + failure );
			await dumpPage( page, diagnostics );
		}

		const tests = results ? results.tests : [];
		const modules = [];
		const byModule = {};
		tests.forEach( ( test ) => {
			if ( !byModule[ test.module ] ) {
				byModule[ test.module ] = { name: test.module, passed: 0, failed: 0 };
				modules.push( byModule[ test.module ] );
			}
			byModule[ test.module ][ test.failed ? "failed" : "passed" ]++;
		} );

		log( "\nPer-module results:" );
		modules.forEach( ( m ) => {
			log( "  " + m.name + ": " + ( m.passed + m.failed ) + " tests, " +
				m.passed + " passed, " + m.failed + " failed" );
		} );

		const failing = tests.filter( ( test ) => test.failed );
		if ( failing.length ) {
			log( "\nFailing tests:" );
			failing.forEach( ( test ) => log( formatFailure( test ) ) );
		}

		const assertions = tests.reduce( ( sum, test ) => sum + test.total, 0 );
		const failedAssertions = tests.reduce( ( sum, test ) => sum + test.failed, 0 );
		log( "\nQUnit summary: " + tests.length + " tests, " +
			( tests.length - failing.length ) + " passed, " + failing.length + " failed; " +
			assertions + " assertions, " + failedAssertions + " failed assertions" +
			( results && results.summary ? " (" + results.summary.runtime + " ms)" : "" ) );

		if ( failure ) {
			log( "ERROR: " + failure );
		} else if ( !tests.length ) {
			log( "ERROR: no tests ran" );
		} else if ( !failing.length ) {
			exitCode = 0;
		}
	} catch ( err ) {
		log( "ERROR: " + ( err && err.stack || err ) );
	} finally {
		if ( browser ) {
			await browser.close();
		}
		if ( server ) {
			server.kill();
		}
	}
	process.exit( exitCode );
}

main();
