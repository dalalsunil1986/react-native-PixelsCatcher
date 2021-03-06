/* @flow */
const fs = require('fs');
const { spawn } = require('child_process');

const log = require('./log');
const timeToSec = require('./timeToSec');
const exec = require('./exec');

export type TestcaseType = {|
  failure: string | void,
  isSkipped: boolean | void,
  name: string,
  renderTime?: number,
  time: number,
|};

const TAG = 'PIXELS_CATCHER::REPORTER';

const timeReducer = (time: number, testcase: TestcaseType): number =>
  time + testcase.time;

const filterSkipped = (testcase: TestcaseType): boolean =>
  !testcase.isSkipped;

const filterFailed = (testcase: TestcaseType): boolean =>
  !testcase.failure;

class TestReporter {
  _name: string;

  _className: string;

  _tests: Array<TestcaseType> = [];

  _minRenderTime = {
    name: '-',
    time: Number.MAX_VALUE,
  };

  _maxRenderTime = {
    name: '-',
    time: Number.MIN_VALUE,
  };

  _timeoutReported: boolean = false;

  _deviceLogs = [];

  _stopDeviceLogger: Function | void;

  constructor(name: string, className: string) {
    this._name = name;
    this._className = className;
  }

  reportTimeout() {
    this._timeoutReported = true;
  }

  resetTimeout() {
    this._timeoutReported = false;
  }

  reportTest(testCase: TestcaseType) {
    this._tests.push(testCase);
    if (testCase.renderTime === undefined) {
      return;
    }
    if (testCase.renderTime < this._minRenderTime.time) {
      this._minRenderTime.time = testCase.renderTime;
      this._minRenderTime.name = testCase.name;
    }
    if (testCase.renderTime > this._maxRenderTime.time) {
      this._maxRenderTime.time = testCase.renderTime;
      this._maxRenderTime.name = testCase.name;
    }
  }

  isPassed() {
    return this._getFailedTests().length === 0;
  }

  toLog() {
    global.console.log('');
    global.console.log('==> Testing completed <==');

    const failedTests = this._getFailedTests();
    const passedTests = this._getPassedTests();
    const skippedTests = this._getSkippedTests();
    const reportTable = [];

    this._tests.forEach((testcase: TestcaseType) => {
      let status = 'PASSED';

      if (testcase.failure) {
        status = 'FAILED';
      } else if (testcase.isSkipped) {
        status = 'SKIPPED';
      }

      reportTable.push({
        name: testcase.name,
        status,
        time: timeToSec(testcase.time),
        renderTime: testcase.renderTime !== undefined ? timeToSec(testcase.renderTime) : '-',
        failure: testcase.failure || '-',
      });
    });

    global.console.table(reportTable);

    global.console.log('');
    global.console.log('==> Summary: <==');

    if (this._timeoutReported) {
      global.console.log('');
      global.console.log('==> Not all tests are processed due to timeout <==');
    }

    global.console.table([
      ['Total tests', this._tests.length],
      ['Passed tests', passedTests.length],
      ['Skipped tests', skippedTests.length],
      ['Failed tests', failedTests.length],
      ['Min render time', `${this._minRenderTime.time}ms (${this._minRenderTime.name})`],
      ['Max render time', `${this._maxRenderTime.time}ms (${this._maxRenderTime.name})`],
    ]);

    if (failedTests.length > 0) {
      global.console.log('==> Failed tests: <==');
      global.console.table(failedTests.map((testCase: TestcaseType) => testCase.name));
    }
  }

  deviceLogsToFile(fileName: string) {
    if (this._stopDeviceLogger) {
      this._stopDeviceLogger();
      this._stopDeviceLogger = undefined;
    }
    fs.writeFileSync(fileName, this._deviceLogs.join(''));
  }

  tojUnit(jUnitFile: string) {
    const xmlResult = ['<?xml version="1.0" encoding="UTF-8"?>'];
    xmlResult.push('<testsuites' +
                   ` name="${this._name}"` +
                   ` tests="${this._tests.length}"` +
                   ` skipped="${this._getSkippedTests().length}"` +
                   ' errors="0"' +
                   ` failures="${this._getFailedTests().length}"` +
                   ` time="${timeToSec(this._getTotalTime())}" >`);
    xmlResult.push('  <testsuite' +
                   ` name="${this._name}"` +
                   ` tests="${this._tests.length}"` +
                   ` skipped="${this._getSkippedTests().length}"` +
                   ' errors="0"' +
                   ` failures="${this._getFailedTests().length}"` +
                   ` time="${timeToSec(this._getTotalTime())}" >`);
    this._tests.forEach((testcase: TestcaseType) => {
      xmlResult.push('    <testcase' +
                     ` classname="${this._className}"` +
                     ` name="${testcase.name}"` +
                     ` time="${timeToSec(testcase.time)}">`);
      if (testcase.failure) {
        xmlResult.push(`      <failure>${testcase.failure}</failure>`);
      } else if (testcase.isSkipped) {
        xmlResult.push('      <skipped/>');
      }
      xmlResult.push('    </testcase>');
    });
    xmlResult.push('  </testsuite>');
    xmlResult.push('</testsuites>');
    xmlResult.push('');
    fs.writeFileSync(jUnitFile, xmlResult.join('\n'));
  }

  _getPassedTests() {
    return this._tests
      .filter(filterSkipped)
      .filter(filterFailed);
  }

  _getSkippedTests() {
    return this._tests
      .filter((testcase: TestcaseType): boolean => Boolean(testcase.isSkipped));
  }

  _getFailedTests() {
    return this._tests
      .filter(filterSkipped)
      .filter((test: TestcaseType) => Boolean(test.failure));
  }

  _getTotalTime() {
    return this._tests
      .filter(filterSkipped)
      .reduce(timeReducer, 0);
  }

  collectLogs(platform: string, packageName: string) {
    let spawnProcess;
    if (platform === 'android') {
      exec('adb logcat -c');
      spawnProcess = spawn('adb', [
        'logcat', `${packageName}:I`, '*:V',
      ]);
    } else if (platform === 'ios') {
      spawnProcess = spawn('xcrun', [
        'simctl', 'spawn', 'booted', 'log', 'stream',
      ]);
    } else {
      log.e(TAG, `Not supported or invalid platform [${platform}]`);
      return;
    }

    spawnProcess.stdout.on('data', (data: any): any => {
      const stringRepresentation = data.toString();
      this._deviceLogs.push(stringRepresentation);
    });

    this._stopDeviceLogger = () => {
      (spawnProcess.stdin: any).pause();
      spawnProcess.kill();
    };
  }
}

module.exports = TestReporter;
