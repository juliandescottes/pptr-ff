/**
 * Copyright 2017 Google Inc. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
const os = require('os');
const path = require('path');
const removeFolder = require('rimraf');
const childProcess = require('child_process');
const BrowserFetcher = require('./BrowserFetcher');
const {Connection} = require('./Connection');
const {Browser} = require('./Browser');
const readline = require('readline');
const fs = require('fs');
const {helper, assert, debugError} = require('./helper');
const FirefoxDownloadPath = require(path.join(helper.projectRoot(), 'package.json')).puppeteer.firefox_download_path;

const mkdtempAsync = helper.promisify(fs.mkdtemp);
const writeFileAsync = helper.promisify(fs.writeFile);
const removeFolderAsync = helper.promisify(removeFolder);

const FIREFOX_PROFILE_PATH = path.join(os.tmpdir(), 'puppeteer_firefox_profile-');


const DEFAULT_ARGS = [
  '--no-remote',
  '--foreground',
];

const AUTOMATION_ARGS = [];

class Launcher {
  /**
   * @param {!LaunchOptions=} options
   * @return {!Promise<!Browser>}
   */
  static async launch(options) {
    options = Object.assign({}, options || {});
    assert(!options.ignoreDefaultArgs || !options.appMode, '`appMode` flag cannot be used together with `ignoreDefaultArgs`');
    const temporaryUserDataDir = null;
    const firefoxArguments = [];
    if (!options.ignoreDefaultArgs)
      firefoxArguments.push(...DEFAULT_ARGS);
    if (options.appMode) {
      options.headless = false;
      options.pipe = true;
    } else if (!options.ignoreDefaultArgs) {
      firefoxArguments.push(...AUTOMATION_ARGS);
    }

    if (!options.ignoreDefaultArgs || !firefoxArguments.some(argument => argument.startsWith('--remote-debugging-')))
      firefoxArguments.push(options.pipe ? '--remote-debugging-pipe' : '--remote-debugging-port=0');

    if (options.devtools === true) {
      firefoxArguments.push('--auto-open-devtools-for-tabs');
      options.headless = false;
    }
    if (typeof options.headless !== 'boolean' || options.headless) {
      firefoxArguments.push(
          '--headless',
      );
    }
    if (Array.isArray(options.args) && options.args.every(arg => arg.startsWith('-')))
      firefoxArguments.push('about:blank');

    let temporaryProfileDir = null;
    if (!firefoxArguments.includes('-profile') && !firefoxArguments.includes('--profile')) {
      temporaryProfileDir = await mkdtempAsync(FIREFOX_PROFILE_PATH);
      const prefs = [
        ['browser.dom.window.dump.enabled', 'true'],
        ['remote.enabled', 'true'],
        ['startup.homepage_welcome_url', '""'],
        ['startup.homepage_welcome_url.additional', '""'],
        ['toolkit.telemetry.reportingpolicy.firstRun', 'false'],
      ];
      const prefsFileContent = prefs.reduce((p, pref) => p + `user_pref("${pref[0]}", ${pref[1]});\n`, '');
      await writeFileAsync(path.join(temporaryProfileDir, 'prefs.js'), prefsFileContent);
      firefoxArguments.push(`-profile`, temporaryProfileDir);
    }

    let firefoxExecutable = options.executablePath;
    if (typeof firefoxExecutable !== 'string') {
      const browserFetcher = new BrowserFetcher();

      const revision = browserFetcher.getRevisionFromPath(FirefoxDownloadPath);
      const revisionInfo = browserFetcher.revisionInfo(revision);
      assert(revisionInfo.local, `Firefox revision is not downloaded. Run "npm install" or "yarn install"`);
      firefoxExecutable = revisionInfo.executablePath;
    }
    if (Array.isArray(options.args))
      firefoxArguments.push(...options.args);

    const usePipe = firefoxArguments.includes('--remote-debugging-pipe');
    const stdio = ['pipe', 'pipe', 'pipe'];
    if (usePipe)
      stdio.push('pipe', 'pipe');
    const firefoxProcess = childProcess.spawn(
        firefoxExecutable,
        firefoxArguments,
        {
          // On non-windows platforms, `detached: false` makes child process a leader of a new
          // process group, making it possible to kill child process tree with `.kill(-pid)` command.
          // @see https://nodejs.org/api/child_process.html#child_process_options_detached
          detached: process.platform !== 'win32',
          env: options.env || process.env,
          stdio
        }
    );

    if (options.dumpio) {
      firefoxProcess.stderr.pipe(process.stderr);
      firefoxProcess.stdout.pipe(process.stdout);
    }

    let firefoxClosed = false;
    const waitForFirefoxToClose = new Promise((fulfill, reject) => {
      firefoxProcess.once('exit', () => {
        firefoxClosed = true;
        // Cleanup as processes exit.
        if (temporaryUserDataDir) {
          removeFolderAsync(temporaryUserDataDir)
              .then(() => fulfill())
              .catch(err => console.error(err));
        } else {
          fulfill();
        }
      });
    });

    const listeners = [ helper.addEventListener(process, 'exit', killFirefox) ];
    if (options.handleSIGINT !== false)
      listeners.push(helper.addEventListener(process, 'SIGINT', () => { killFirefox(); process.exit(130); }));
    if (options.handleSIGTERM !== false)
      listeners.push(helper.addEventListener(process, 'SIGTERM', gracefullyCloseFirefox));
    if (options.handleSIGHUP !== false)
      listeners.push(helper.addEventListener(process, 'SIGHUP', gracefullyCloseFirefox));
    /** @type {?Connection} */
    let connection = null;
    try {
      const connectionDelay = options.slowMo || 0;
      if (!usePipe) {
        const timeout = helper.isNumber(options.timeout) ? options.timeout : 30000;
        const browserWSEndpoint = await waitForWSEndpoint(firefoxProcess, timeout);
        connection = await Connection.createForWebSocket(browserWSEndpoint, connectionDelay);
      } else {
        connection = Connection.createForPipe(/** @type {!NodeJS.WritableStream} */(firefoxProcess.stdio[3]), /** @type {!NodeJS.ReadableStream} */ (firefoxProcess.stdio[4]), connectionDelay);
      }
      const ignoreHTTPSErrors = !!options.ignoreHTTPSErrors;
      const setDefaultViewport = !options.appMode;
      const browser = await Browser.create(connection, [], ignoreHTTPSErrors, setDefaultViewport, firefoxProcess, gracefullyCloseFirefox);
      await ensureInitialPage(browser);
      return browser;
    } catch (e) {
      killFirefox();
      throw e;
    }

    /**
     * @param {!Browser} browser
     */
    async function ensureInitialPage(browser) {
      // Wait for initial page target to be created.
      if (browser.targets().find(target => target.type() === 'page'))
        return;

      let initialPageCallback;
      const initialPagePromise = new Promise(resolve => initialPageCallback = resolve);
      const listeners = [helper.addEventListener(browser, 'targetcreated', target => {
        if (target.type() === 'page')
          initialPageCallback();
      })];

      await initialPagePromise;
      helper.removeEventListeners(listeners);
    }

    /**
     * @return {Promise}
     */
    function gracefullyCloseFirefox() {
      helper.removeEventListeners(listeners);
      if (temporaryUserDataDir) {
        killFirefox();
      } else if (connection) {
        // Attempt to close firefox gracefully
        connection.send('Browser.close').catch(error => {
          debugError(error);
          killFirefox();
        });
      }
      return waitForFirefoxToClose;
    }

    // This method has to be sync to be used as 'exit' event handler.
    function killFirefox() {
      helper.removeEventListeners(listeners);
      if (firefoxProcess.pid && !firefoxProcess.killed && !firefoxClosed) {
        // Force kill firefox.
        try {
          if (process.platform === 'win32')
            childProcess.execSync(`taskkill /pid ${firefoxProcess.pid} /T /F`);
          else
            process.kill(-firefoxProcess.pid, 'SIGKILL');
        } catch (e) {
          // the process might have already stopped
        }
      }
      // Attempt to remove temporary profile directory to avoid littering.
      try {
        removeFolder.sync(temporaryUserDataDir);
      } catch (e) { }
    }
  }

  /**
   * @return {!Array<string>}
   */
  static defaultArgs() {
    return DEFAULT_ARGS.concat(AUTOMATION_ARGS);
  }

  /**
   * @return {string}
   */
  static executablePath() {
    const browserFetcher = new BrowserFetcher();
    const revisionInfo = browserFetcher.revisionInfo(FirefoxDownloadPath);
    return revisionInfo.executablePath;
  }

  /**
   * @param {!Object=} options
   * @return {!Promise<!Browser>}
   */
  static async connect(options = {}) {
    const connectionDelay = options.slowMo || 0;
    const connection = await Connection.createForWebSocket(options.browserWSEndpoint, connectionDelay);
    const {browserContextIds} = await connection.send('Target.getBrowserContexts');
    const ignoreHTTPSErrors = !!options.ignoreHTTPSErrors;
    return Browser.create(connection, browserContextIds, ignoreHTTPSErrors, true /* setDefaultViewport */, null, () => connection.send('Browser.close').catch(debugError));
  }
}

/**
 * @param {!Puppeteer.ChildProcess} firefoxProcess
 * @param {number} timeout
 * @return {!Promise<string>}
 */
function waitForWSEndpoint(firefoxProcess, timeout) {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: firefoxProcess.stdout });

    let stderr = '';
    const listeners = [
      helper.addEventListener(rl, 'line', onLine),
      helper.addEventListener(rl, 'close', () => onClose()),
      helper.addEventListener(firefoxProcess, 'exit', () => onClose()),
      helper.addEventListener(firefoxProcess, 'error', error => onClose(error))
    ];
    const timeoutId = timeout ? setTimeout(onTimeout, timeout) : 0;

    /**
     * @param {!Error=} error
     */
    function onClose(error) {
      cleanup();
      reject(new Error([
        'Failed to launch Firefox!' + (error ? ' ' + error.message : ''),
        stderr,
        '',
        'TROUBLESHOOTING: https://github.com/GoogleFirefox/puppeteer/blob/master/docs/troubleshooting.md',
        '',
      ].join('\n')));
    }

    function onTimeout() {
      cleanup();
      reject(new Error(`Timed out after ${timeout} ms while trying to connect to Firefox! The only firefox guaranteed to work is ${FirefoxDownloadPath}`));
    }

    /**
     * @param {string} line
     */
    function onLine(line) {
      stderr += line + '\n';
      const match = line.match(/^DevTools listening on (ws:\/\/.*)$/);
      if (!match)
        return;
      cleanup();
      resolve(match[1]);
    }

    function cleanup() {
      if (timeoutId)
        clearTimeout(timeoutId);
      helper.removeEventListeners(listeners);
    }
  });
}

/**
 * @typedef {Object} LaunchOptions
 * @property {boolean=} ignoreHTTPSErrors
 * @property {boolean=} headless
 * @property {string=} executablePath
 * @property {number=} slowMo
 * @property {!Array<string>=} args
 * @property {boolean=} ignoreDefaultArgs
 * @property {boolean=} handleSIGINT
 * @property {boolean=} handleSIGTERM
 * @property {boolean=} handleSIGHUP
 * @property {number=} timeout
 * @property {boolean=} dumpio
 * @property {string=} userDataDir
 * @property {!Object<string, string | undefined>=} env
 * @property {boolean=} devtools
 * @property {boolean=} pipe
 * @property {boolean=} appMode
 */


module.exports = Launcher;
