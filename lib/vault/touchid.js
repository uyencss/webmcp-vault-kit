'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, execFile } = require('child_process');
const { getDataDir } = require('../config.js');
const { readKeySource, readKeychainKey } = require('./key-source.js');

const OBJC_HELPER_SOURCE = `
#import <Foundation/Foundation.h>
#import <LocalAuthentication/LocalAuthentication.h>

int main(int argc, const char * argv[]) {
    @autoreleasepool {
        NSString *mode = argc > 1 ? [NSString stringWithUTF8String:argv[1]] : @"verify";
        NSString *reason = argc > 2 ? [NSString stringWithUTF8String:argv[2]] : @"Xác thực mở khóa WebMCP Vault";

        LAContext *context = [[LAContext alloc] init];
        NSError *authError = nil;

        if ([mode isEqualToString:@"status"]) {
            BOOL bioAvailable = [context canEvaluatePolicy:LAPolicyDeviceOwnerAuthenticationWithBiometrics error:&authError];
            BOOL ownerAvailable = [context canEvaluatePolicy:LAPolicyDeviceOwnerAuthentication error:nil];
            NSString *biometryType = @"none";
            if (@available(macOS 10.15, *)) {
                if (context.biometryType == LABiometryTypeTouchID) biometryType = @"touchID";
                else if (context.biometryType == LABiometryTypeFaceID) biometryType = @"faceID";
            }
            NSDictionary *outDict = @{
                @"supported": @(bioAvailable || ownerAvailable),
                @"biometricsAvailable": @(bioAvailable),
                @"biometryType": biometryType,
                @"error": authError ? authError.localizedDescription : @""
            };
            NSData *data = [NSJSONSerialization dataWithJSONObject:outDict options:0 error:nil];
            NSString *json = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
            printf("%s\\n", [json UTF8String]);
            return 0;
        }

        dispatch_semaphore_t sem = dispatch_semaphore_create(0);
        __block BOOL successResult = NO;
        __block NSString *errorMessage = @"";

        LAPolicy policy = [context canEvaluatePolicy:LAPolicyDeviceOwnerAuthenticationWithBiometrics error:nil]
            ? LAPolicyDeviceOwnerAuthenticationWithBiometrics
            : LAPolicyDeviceOwnerAuthentication;

        [context evaluatePolicy:policy localizedReason:reason reply:^(BOOL success, NSError * _Nullable error) {
            successResult = success;
            if (error) {
                errorMessage = error.localizedDescription;
            }
            dispatch_semaphore_signal(sem);
        }];

        dispatch_semaphore_wait(sem, DISPATCH_TIME_FOREVER);
        if (successResult) {
            printf("{\\"ok\\":true}\\n");
            return 0;
        } else {
            NSString *escaped = [errorMessage stringByReplacingOccurrencesOfString:@"\\"" withString:@"\\\\\\""];
            fprintf(stderr, "{\\"ok\\":false,\\"error\\":\\"%s\\"}\\n", [escaped UTF8String]);
            return 1;
        }
    }
}
`.trim();

const SWIFT_HELPER_SOURCE = `
import Foundation
import LocalAuthentication

let args = CommandLine.arguments
let mode = args.count > 1 ? args[1] : "verify"
let reason = args.count > 2 ? args[2] : "Xác thực mở khóa WebMCP Vault"

let context = LAContext()
var authError: NSError?

if mode == "status" {
    let bioAvailable = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &authError)
    let ownerAvailable = context.canEvaluatePolicy(.deviceOwnerAuthentication, error: nil)
    let biometryType: String
    switch context.biometryType {
    case .touchID: biometryType = "touchID"
    case .faceID: biometryType = "faceID"
    default: biometryType = "none"
    }
    let out: [String: Any] = [
        "supported": bioAvailable || ownerAvailable,
        "biometricsAvailable": bioAvailable,
        "biometryType": biometryType,
        "error": authError?.localizedDescription ?? ""
    ]
    if let data = try? JSONSerialization.data(withJSONObject: out),
       let json = String(data: data, encoding: .utf8) {
        print(json)
    }
    exit(0)
}

let semaphore = DispatchSemaphore(value: 0)
var successResult = false
var errorMessage = ""

let policy: LAPolicy = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil)
    ? .deviceOwnerAuthenticationWithBiometrics
    : .deviceOwnerAuthentication

context.evaluatePolicy(policy, localizedReason: reason) { success, error in
    successResult = success
    if let err = error {
        errorMessage = err.localizedDescription
    }
    semaphore.signal()
}

semaphore.wait()
if successResult {
    print("{\\"ok\\":true}")
    exit(0)
} else {
    let escaped = errorMessage.replacingOccurrences(of: "\\"", with: "\\\\\\"")
    fputs("{\\"ok\\":false,\\"error\\":\\"\\(escaped)\\"}\\n", stderr)
    exit(1)
}
`.trim();

function getTouchIdHelperPaths(dataDir = getDataDir()) {
  const binDir = path.join(dataDir, 'bin');
  return {
    binDir,
    objcFile: path.join(binDir, 'webmcp-touchid.m'),
    swiftFile: path.join(binDir, 'webmcp-touchid.swift'),
    binaryFile: path.join(binDir, 'webmcp-touchid'),
  };
}

function ensureTouchIdBinary(dataDir = getDataDir()) {
  if (os.platform() !== 'darwin') return null;
  const { binDir, objcFile, swiftFile, binaryFile } = getTouchIdHelperPaths(dataDir);
  if (fs.existsSync(binaryFile)) return binaryFile;
  fs.mkdirSync(binDir, { recursive: true, mode: 0o700 });

  // Tier 1: Apple clang + Objective-C (100ms compile, zero modulemap collisions on macOS 15)
  try {
    fs.writeFileSync(objcFile, `${OBJC_HELPER_SOURCE}\n`, { mode: 0o600 });
    execFileSync('clang', [
      '-O2',
      '-framework', 'Foundation',
      '-framework', 'LocalAuthentication',
      '-fobjc-arc',
      objcFile,
      '-o', binaryFile,
    ], {
      stdio: 'ignore',
      timeout: 10000,
    });
    fs.chmodSync(binaryFile, 0o700);
    return binaryFile;
  } catch {}

  // Tier 2: swiftc fallback
  try {
    fs.writeFileSync(swiftFile, `${SWIFT_HELPER_SOURCE}\n`, { mode: 0o600 });
    execFileSync('swiftc', ['-O', swiftFile, '-o', binaryFile], {
      stdio: 'ignore',
      timeout: 20000,
    });
    fs.chmodSync(binaryFile, 0o700);
    return binaryFile;
  } catch {
    return null;
  }
}

function resolveDefaultFileOrKeychainKey(dataDir = getDataDir(), env = process.env) {
  const src = readKeySource({ env, allowKeychain: true });
  if (src.available && src.key) return { available: true, source: src.source, key: src.key };
  const candidates = [
    path.join(dataDir, 'vault', 'vault.key'),
    path.join(dataDir, 'vault.key'),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        const val = fs.readFileSync(candidate, 'utf8').trim();
        if (val) return { available: true, source: 'file', key: val, keyFile: candidate };
      }
    } catch {}
  }
  const kc = readKeychainKey();
  if (kc) return { available: true, source: 'keychain', key: kc };
  return { available: false, source: 'missing', key: null };
}

let cachedTouchIdStatus = null;
let cachedTouchIdTime = 0;

function getTouchIdStatus(options = {}) {
  if (os.platform() !== 'darwin') {
    return { supported: false, biometricsAvailable: false, biometryType: 'none', platform: os.platform() };
  }
  const now = Date.now();
  if (cachedTouchIdStatus && now - cachedTouchIdTime < 30000) {
    return cachedTouchIdStatus;
  }

  const dataDir = options.dataDir || getDataDir();
  const keySource = resolveDefaultFileOrKeychainKey(dataDir, options.env || process.env);
  const binary = ensureTouchIdBinary(dataDir);
  if (!binary) {
    const fallbackStatus = {
      supported: true,
      biometricsAvailable: true,
      biometryType: 'touchID',
      keyAvailable: Boolean(keySource.available),
      keySource: keySource.source,
      helperCompiled: false,
    };
    cachedTouchIdStatus = fallbackStatus;
    cachedTouchIdTime = now;
    return fallbackStatus;
  }
  try {
    const stdout = execFileSync(binary, ['status'], { encoding: 'utf8', timeout: 5000 }).trim();
    const parsed = JSON.parse(stdout);
    const result = {
      ...parsed,
      keyAvailable: Boolean(keySource.available),
      keySource: keySource.source,
      helperCompiled: true,
    };
    cachedTouchIdStatus = result;
    cachedTouchIdTime = now;
    return result;
  } catch (err) {
    return {
      supported: true,
      biometricsAvailable: false,
      biometryType: 'touchID',
      keyAvailable: Boolean(keySource.available),
      keySource: keySource.source,
      error: err.message,
    };
  }
}

function evaluateTouchId({ reason = 'Mở khóa WebMCP Vault bằng Touch ID', dataDir = getDataDir() } = {}) {
  return new Promise((resolve, reject) => {
    if (os.platform() !== 'darwin') {
      reject(new Error('Touch ID is only supported on macOS.'));
      return;
    }
    const binary = ensureTouchIdBinary(dataDir);
    if (binary) {
      execFile(binary, ['verify', reason], { timeout: 60000 }, (error, stdout, stderr) => {
        if (!error) {
          resolve({ ok: true, method: 'objc-lacontext' });
          return;
        }
        let message = 'Touch ID authentication was cancelled or failed.';
        try {
          const parsed = JSON.parse(String(stderr || stdout || '').trim());
          if (parsed && parsed.error) message = parsed.error;
        } catch {
          if (stderr && String(stderr).trim()) message = String(stderr).trim();
        }
        reject(new Error(message));
      });
      return;
    }

    // Fallback to JXA LocalAuthentication if compiler was unavailable
    const jxaScript = `
      ObjC.import('LocalAuthentication');
      ObjC.import('Foundation');
      const ctx = $.LAContext.alloc.init;
      let done = false, ok = false;
      ctx.evaluatePolicyLocalizedReasonReply(2, ${JSON.stringify(reason)}, (s) => { ok = s; done = true; });
      while (!done) $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.05));
      if (!ok) throw new Error('Touch ID denied');
    `;
    execFile('osascript', ['-l', 'JavaScript', '-e', jxaScript], { timeout: 60000 }, (error) => {
      if (!error) resolve({ ok: true, method: 'jxa-lacontext' });
      else reject(new Error('Touch ID authentication was cancelled or failed.'));
    });
  });
}

module.exports = {
  ensureTouchIdBinary,
  resolveDefaultFileOrKeychainKey,
  getTouchIdStatus,
  evaluateTouchId,
};
