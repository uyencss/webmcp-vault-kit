#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import <Carbon/Carbon.h>
#import <ApplicationServices/ApplicationServices.h>
#import <objc/message.h>

static NSString * const kVaultAppBundleId = @"io.webmcp.vault.app";
static const OSType kHotKeySignature = 'WMVT';
static const UInt32 kHotKeyId = 1;

@interface AppDelegate : NSObject <NSApplicationDelegate, NSWindowDelegate, NSPopoverDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler>
@property (strong, nonatomic) NSStatusItem *statusItem;
@property (strong, nonatomic) NSMenu *statusMenu;
@property (strong, nonatomic) NSMenuItem *quickFillMenuItem;
@property (strong, nonatomic) NSPopover *popover;
@property (strong, nonatomic) WKWebView *popoverWebView;
@property (strong, nonatomic) NSWindow *window;
@property (strong, nonatomic) WKWebView *webView;
@property (copy, nonatomic) NSString *explicitUrl;
@property (assign, nonatomic) NSInteger retryCount;
@property (assign, nonatomic) BOOL didKickstartDaemon;
@property (assign, nonatomic) BOOL startInTray;
@property (assign, nonatomic) NSInteger copiedChangeCount;
@property (assign, nonatomic) EventHotKeyRef globalHotKeyRef;
@property (assign, nonatomic) EventHandlerRef hotKeyHandlerRef;
@property (strong, nonatomic) NSRunningApplication *targetApp;
@property (assign, nonatomic) BOOL targetIsSecureField;
@property (assign, nonatomic) BOOL targetIsTerminal;
@property (assign, nonatomic) BOOL pendingMacTargetPush;
@property (assign, nonatomic) NSUInteger autofillGeneration;
- (void)triggerQuickAutofill;
@end

static OSStatus HotKeyEventHandler(EventHandlerCallRef nextHandler, EventRef theEvent, void *userData) {
    (void)nextHandler;
    EventHotKeyID hkId;
    if (GetEventParameter(theEvent, kEventParamDirectObject, typeEventHotKeyID, NULL, sizeof(hkId), NULL, &hkId) != noErr) {
        return eventNotHandledErr;
    }
    if (hkId.signature != kHotKeySignature || hkId.id != kHotKeyId) {
        return eventNotHandledErr;
    }
    AppDelegate *delegate = (__bridge AppDelegate *)userData;
    dispatch_async(dispatch_get_main_queue(), ^{
        [delegate triggerQuickAutofill];
    });
    return noErr;
}

@implementation AppDelegate

- (void)applicationDidFinishLaunching:(NSNotification *)aNotification {
    (void)aNotification;
    NSArray *args = [[NSProcessInfo processInfo] arguments];
    for (NSUInteger i = 0; i < args.count; i++) {
        if ([args[i] isEqualToString:@"--url"] && i + 1 < args.count) {
            self.explicitUrl = args[i + 1];
        } else if ([args[i] isEqualToString:@"--tray"] || [args[i] isEqualToString:@"--background"]) {
            self.startInTray = YES;
        }
    }

    pid_t selfPid = [NSRunningApplication currentApplication].processIdentifier;
    for (NSRunningApplication *app in [NSRunningApplication runningApplicationsWithBundleIdentifier:kVaultAppBundleId]) {
        if (app.processIdentifier != selfPid && !app.terminated) {
            if (!self.startInTray) {
                [app activateWithOptions:0];
            }
            [NSApp terminate:nil];
            return;
        }
    }

    [self setupMainMenu];
    [self setupStatusItem];
    [self setupPopover];
    [self setupMainWindow];
    [self registerGlobalHotKey];
    [self loadWebContent];
    if (self.startInTray) {
        [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    } else {
        [self showMainWindow];
    }
}

- (NSString *)resolveVaultUrl {
    if (self.explicitUrl.length > 0) {
        NSURL *candidate = [NSURL URLWithString:self.explicitUrl];
        if ([candidate.scheme isEqualToString:@"http"] &&
            ([candidate.host isEqualToString:@"127.0.0.1"] || [candidate.host isEqualToString:@"localhost"])) {
            return self.explicitUrl;
        }
    }
    NSString *webmcpHome = [[[NSProcessInfo processInfo] environment] objectForKey:@"WEBMCP_HOME"];
    if (!webmcpHome.length) webmcpHome = [NSHomeDirectory() stringByAppendingPathComponent:@".webmcp"];
    NSData *data = [NSData dataWithContentsOfFile:[webmcpHome stringByAppendingPathComponent:@"vault/vault-ui.json"]];
    if (data) {
        id json = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
        NSString *urlStr = [json isKindOfClass:[NSDictionary class]] && [json[@"url"] isKindOfClass:[NSString class]] ? json[@"url"] : @"";
        if (urlStr.length > 0) {
            for (NSString *prefix in @[@"http://0.0.0.0:", @"http://[::]:", @"http://:::"]) {
                urlStr = [urlStr stringByReplacingOccurrencesOfString:prefix withString:@"http://127.0.0.1:"];
            }
            return urlStr;
        }
    }
    return @"http://127.0.0.1:7876";
}

- (void)setupMainMenu {
    NSMenu *menubar = [[NSMenu alloc] init];
    NSMenuItem *appMenuItem = [[NSMenuItem alloc] init];
    [menubar addItem:appMenuItem];

    NSMenu *appMenu = [[NSMenu alloc] init];
    [appMenu addItemWithTitle:@"Reload Vault UI" action:@selector(reloadWeb) keyEquivalent:@"r"];
    [appMenu addItemWithTitle:@"Close Window" action:@selector(performClose:) keyEquivalent:@"w"];
    [appMenu addItem:[NSMenuItem separatorItem]];
    [appMenu addItemWithTitle:@"Quit WebMCP Vault" action:@selector(terminate:) keyEquivalent:@"q"];
    [appMenuItem setSubmenu:appMenu];

    NSMenuItem *editMenuItem = [[NSMenuItem alloc] init];
    [menubar addItem:editMenuItem];
    NSMenu *editMenu = [[NSMenu alloc] initWithTitle:@"Edit"];
    [editMenu addItemWithTitle:@"Undo" action:NSSelectorFromString(@"undo:") keyEquivalent:@"z"];
    [editMenu addItemWithTitle:@"Redo" action:NSSelectorFromString(@"redo:") keyEquivalent:@"Z"];
    [editMenu addItem:[NSMenuItem separatorItem]];
    [editMenu addItemWithTitle:@"Cut" action:@selector(cut:) keyEquivalent:@"x"];
    [editMenu addItemWithTitle:@"Copy" action:@selector(copy:) keyEquivalent:@"c"];
    [editMenu addItemWithTitle:@"Paste" action:@selector(paste:) keyEquivalent:@"v"];
    [editMenu addItemWithTitle:@"Select All" action:@selector(selectAll:) keyEquivalent:@"a"];
    [editMenuItem setSubmenu:editMenu];

    [NSApp setMainMenu:menubar];
}

- (void)setupStatusItem {
    self.statusItem = [[NSStatusBar systemStatusBar] statusItemWithLength:NSSquareStatusItemLength];
    NSStatusBarButton *button = self.statusItem.button;
    if (button) {
        button.toolTip = @"WebMCP Vault (⌘\\)";
        if (@available(macOS 11.0, *)) {
            NSImageSymbolConfiguration *config = [NSImageSymbolConfiguration configurationWithPointSize:16 weight:NSFontWeightSemibold];
            NSImage *icon = [[NSImage imageWithSystemSymbolName:@"lock.shield.fill" accessibilityDescription:@"WebMCP Vault"] imageWithSymbolConfiguration:config];
            if (icon) {
                icon.template = YES;
                button.image = icon;
                button.imagePosition = NSImageOnly;
                button.title = @"";
            } else {
                button.title = @"🔒";
            }
        } else {
            button.title = @"🔒";
        }
        button.target = self;
        button.action = @selector(handleStatusItemClick:);
        [button sendActionOn:(NSEventMaskLeftMouseUp | NSEventMaskRightMouseUp)];
    }

    self.statusMenu = [[NSMenu alloc] initWithTitle:@"WebMCP Vault"];
    self.quickFillMenuItem = [[NSMenuItem alloc] initWithTitle:@"Quick AutoFill (⌘\\)" action:@selector(triggerQuickAutofill) keyEquivalent:@""];
    [self.statusMenu addItem:self.quickFillMenuItem];
    [self.statusMenu addItem:[NSMenuItem separatorItem]];
    [self.statusMenu addItemWithTitle:@"Open WebMCP Vault" action:@selector(showMainWindow) keyEquivalent:@"o"];
    [self.statusMenu addItemWithTitle:@"Reload Vault UI" action:@selector(reloadWeb) keyEquivalent:@"r"];
    [self.statusMenu addItemWithTitle:@"Open in Default Browser" action:@selector(openInBrowser) keyEquivalent:@"b"];
    [self.statusMenu addItem:[NSMenuItem separatorItem]];
    [self.statusMenu addItemWithTitle:@"Quit WebMCP Vault App" action:@selector(quitApp) keyEquivalent:@"q"];
    for (NSMenuItem *item in self.statusMenu.itemArray) {
        item.target = self;
    }
}

- (WKWebViewConfiguration *)makeWebViewConfigWithClass:(NSString *)className includeAutofill:(BOOL)includeAutofill {
    WKWebViewConfiguration *config = [[WKWebViewConfiguration alloc] init];
    WKUserContentController *ucc = [[WKUserContentController alloc] init];
    [ucc addScriptMessageHandler:self name:@"openFullApp"];
    [ucc addScriptMessageHandler:self name:@"copyClipboard"];
    if (includeAutofill) {
        [ucc addScriptMessageHandler:self name:@"autofillTarget"];
    }
    NSString *src = [NSString stringWithFormat:@"document.documentElement.classList.add('%@');", className];
    [ucc addUserScript:[[WKUserScript alloc] initWithSource:src injectionTime:WKUserScriptInjectionTimeAtDocumentStart forMainFrameOnly:YES]];
    config.userContentController = ucc;
    return config;
}

- (void)setupPopover {
    WKWebViewConfiguration *popConfig = [self makeWebViewConfigWithClass:@"is-mac-popover" includeAutofill:YES];
    self.popoverWebView = [[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 380, 560) configuration:popConfig];
    self.popoverWebView.navigationDelegate = self;
    self.popoverWebView.UIDelegate = self;

    NSViewController *popoverVC = [[NSViewController alloc] init];
    popoverVC.view = self.popoverWebView;
    popoverVC.preferredContentSize = NSMakeSize(380, 560);

    self.popover = [[NSPopover alloc] init];
    self.popover.contentSize = NSMakeSize(380, 560);
    self.popover.behavior = NSPopoverBehaviorTransient;
    self.popover.contentViewController = popoverVC;
    self.popover.delegate = self;
}

- (void)setupMainWindow {
    NSRect frame = NSMakeRect(0, 0, 1200, 780);
    NSUInteger styleMask = NSWindowStyleMaskTitled | NSWindowStyleMaskClosable |
                           NSWindowStyleMaskMiniaturizable | NSWindowStyleMaskResizable |
                           NSWindowStyleMaskFullSizeContentView;
    self.window = [[NSWindow alloc] initWithContentRect:frame styleMask:styleMask backing:NSBackingStoreBuffered defer:NO];
    [self.window setTitle:@"WebMCP Vault"];
    self.window.titlebarAppearsTransparent = YES;
    self.window.titleVisibility = NSWindowTitleHidden;
    self.window.movableByWindowBackground = NO;
    [self.window setMinSize:NSMakeSize(860, 560)];
    [self.window center];
    [self.window setDelegate:self];
    [self.window setReleasedWhenClosed:NO];

    WKWebViewConfiguration *webConfig = [self makeWebViewConfigWithClass:@"is-mac-app" includeAutofill:NO];
    self.webView = [[WKWebView alloc] initWithFrame:self.window.contentView.bounds configuration:webConfig];
    self.webView.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    self.webView.navigationDelegate = self;
    self.webView.UIDelegate = self;
    [self.window.contentView addSubview:self.webView];
}

- (void)loadWebContent {
    NSURL *url = [NSURL URLWithString:[self resolveVaultUrl]];
    if (url) {
        NSURLRequest *req = [NSURLRequest requestWithURL:url cachePolicy:NSURLRequestReloadIgnoringLocalCacheData timeoutInterval:10.0];
        [self.webView loadRequest:req];
        [self.popoverWebView loadRequest:req];
    }
}

- (void)webView:(WKWebView *)webView didFinishNavigation:(WKNavigation *)navigation {
    (void)navigation;
    [webView evaluateJavaScript:@"document.body ? document.body.innerText : ''" completionHandler:^(id result, NSError *error) {
        (void)error;
        if ([result isKindOfClass:[NSString class]] &&
            [(NSString *)result containsString:@"Unauthorized vault UI request."] &&
            self.retryCount < 4) {
            self.retryCount += 1;
            dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(400 * NSEC_PER_MSEC)), dispatch_get_main_queue(), ^{
                [self loadWebContent];
            });
            return;
        }
        self.retryCount = 0;
        if (self.pendingMacTargetPush && webView == self.popoverWebView) {
            self.pendingMacTargetPush = NO;
            [self pushTargetContextToWebView:webView];
        }
    }];
}

- (void)webView:(WKWebView *)webView didFailProvisionalNavigation:(WKNavigation *)navigation withError:(NSError *)error {
    (void)webView; (void)navigation; (void)error;
    if (!self.didKickstartDaemon) {
        self.didKickstartDaemon = YES;
        NSTask *task = [[NSTask alloc] init];
        task.executableURL = [NSURL fileURLWithPath:@"/bin/launchctl"];
        task.arguments = @[@"start", @"io.webmcp-vault"];
        [task launchAndReturnError:nil];
    }
    if (self.retryCount < 10) {
        self.retryCount += 1;
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(400 * NSEC_PER_MSEC)), dispatch_get_main_queue(), ^{
            [self loadWebContent];
        });
    }
}

- (void)webView:(WKWebView *)webView decidePolicyForNavigationAction:(WKNavigationAction *)navigationAction decisionHandler:(void (^)(WKNavigationActionPolicy))decisionHandler {
    (void)webView;
    NSURL *u = navigationAction.request.URL;
    NSURL *b = [NSURL URLWithString:[self resolveVaultUrl]];
    BOOL same = [u.scheme isEqualToString:b.scheme] && [u.host isEqualToString:b.host] && ((u.port == nil && b.port == nil) || [u.port isEqual:b.port]);
    if (!same && [u.scheme hasPrefix:@"http"]) {
        [[NSWorkspace sharedWorkspace] openURL:u];
    }
    decisionHandler(same ? WKNavigationActionPolicyAllow : WKNavigationActionPolicyCancel);
}

- (WKWebView *)webView:(WKWebView *)webView createWebViewWithConfiguration:(WKWebViewConfiguration *)configuration forNavigationAction:(WKNavigationAction *)navigationAction windowFeatures:(WKWindowFeatures *)windowFeatures {
    (void)webView; (void)configuration; (void)windowFeatures;
    if (navigationAction.request.URL) {
        [[NSWorkspace sharedWorkspace] openURL:navigationAction.request.URL];
    }
    return nil;
}

- (void)ensureFreshWebContent {
    NSString *resolved = [self resolveVaultUrl];
    NSURL *url = [NSURL URLWithString:resolved];
    if (!url) return;
    NSString *mainCur = self.webView.URL.absoluteString ?: @"";
    if (!mainCur.length || ![mainCur isEqualToString:resolved]) {
        [self.webView loadRequest:[NSURLRequest requestWithURL:url cachePolicy:NSURLRequestReloadIgnoringLocalCacheData timeoutInterval:10.0]];
    }
    NSString *popCur = self.popoverWebView.URL.absoluteString ?: @"";
    if (!popCur.length || ![popCur isEqualToString:resolved]) {
        [self.popoverWebView loadRequest:[NSURLRequest requestWithURL:url cachePolicy:NSURLRequestReloadIgnoringLocalCacheData timeoutInterval:10.0]];
    }
}

- (void)showMainWindow {
    if (self.popover.isShown) {
        [self.popover performClose:nil];
    }
    [self ensureFreshWebContent];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
    [self.window makeKeyAndOrderFront:nil];
    [NSApp activateIgnoringOtherApps:YES];
}

- (BOOL)windowShouldClose:(NSWindow *)sender {
    [sender orderOut:nil];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    return NO;
}

- (BOOL)applicationShouldHandleReopen:(NSApplication *)sender hasVisibleWindows:(BOOL)flag {
    (void)sender;
    if (!flag) {
        [self loadWebContent];
    } else {
        [self ensureFreshWebContent];
    }
    [self showMainWindow];
    return YES;
}

- (void)registerGlobalHotKey {
    EventTypeSpec eventType = { .eventClass = kEventClassKeyboard, .eventKind = kEventHotKeyPressed };
    EventHandlerRef handlerRef = NULL;
    if (InstallApplicationEventHandler(&HotKeyEventHandler, 1, &eventType, (__bridge void *)self, &handlerRef) == noErr) {
        self.hotKeyHandlerRef = handlerRef;
        EventHotKeyID hotKeyID = { .signature = kHotKeySignature, .id = kHotKeyId };
        EventHotKeyRef hkRef = NULL;
        OSStatus status = RegisterEventHotKey(kVK_ANSI_Backslash, cmdKey, hotKeyID, GetApplicationEventTarget(), 0, &hkRef);
        if (status == noErr) {
            self.globalHotKeyRef = hkRef;
        } else {
            NSLog(@"[WebMCP Vault] RegisterEventHotKey (Cmd+\\) failed with OSStatus %d", (int)status);
            if (self.statusItem.button) self.statusItem.button.toolTip = @"WebMCP Vault (⌘\\ bị ứng dụng khác chiếm)";
            if (self.quickFillMenuItem) self.quickFillMenuItem.title = @"Quick AutoFill (⌘\\ đang xung đột)";
        }
    }
}

- (BOOL)probeFocusedElementIsSecureForPID:(pid_t)pid {
    if (!AXIsProcessTrusted() || pid <= 0) return NO;
    AXUIElementRef appElem = AXUIElementCreateApplication(pid);
    if (!appElem) return NO;
    AXUIElementSetMessagingTimeout(appElem, 0.3f);

    BOOL isSec = NO;
    CFTypeRef focusedElem = NULL;
    if (AXUIElementCopyAttributeValue(appElem, kAXFocusedUIElementAttribute, &focusedElem) == kAXErrorSuccess && focusedElem) {
        CFTypeRef subrole = NULL;
        if (AXUIElementCopyAttributeValue((AXUIElementRef)focusedElem, kAXSubroleAttribute, &subrole) == kAXErrorSuccess && subrole) {
            if (CFGetTypeID(subrole) == CFStringGetTypeID() &&
                [(__bridge NSString *)subrole isEqualToString:@"AXSecureTextField"]) {
                isSec = YES;
            }
            CFRelease(subrole);
        }
        CFRelease(focusedElem);
    }
    CFRelease(appElem);
    return isSec;
}

- (void)captureFrontmostTargetContext {
    NSRunningApplication *front = [[NSWorkspace sharedWorkspace] frontmostApplication];
    if (!front || [front.bundleIdentifier isEqualToString:kVaultAppBundleId]) return;
    self.targetApp = front;
    NSSet<NSString *> *terminals = [NSSet setWithArray:@[
        @"com.apple.Terminal", @"com.googlecode.iterm2", @"com.mitchellh.ghostty",
        @"com.github.wez.wezterm", @"net.kovidgoyal.kitty", @"org.alacritty", @"org.tabby"
    ]];
    self.targetIsTerminal = front.bundleIdentifier ? [terminals containsObject:front.bundleIdentifier] : NO;
    self.targetIsSecureField = [self probeFocusedElementIsSecureForPID:front.processIdentifier];
}

- (void)pushTargetContextToWebView:(WKWebView *)targetWebView {
    if (!targetWebView || !self.targetApp || self.targetApp.terminated) return;
    BOOL passOnly = self.targetIsTerminal || self.targetIsSecureField;
    NSDictionary *ctx = @{
        @"appName": self.targetApp.localizedName ?: @"",
        @"mode": passOnly ? @"pass_only" : @"user_pass"
    };
    NSData *jsonData = [NSJSONSerialization dataWithJSONObject:ctx options:0 error:nil];
    if (!jsonData) return;
    NSString *jsonStr = [[NSString alloc] initWithData:jsonData encoding:NSUTF8StringEncoding];
    NSString *js = [NSString stringWithFormat:@"window.__webmcpSetMacTarget && window.__webmcpSetMacTarget(%@);", jsonStr];
    [targetWebView evaluateJavaScript:js completionHandler:nil];
}

- (void)openPopoverFromButton:(NSStatusBarButton *)button {
    [self ensureFreshWebContent];
    [self.popover showRelativeToRect:button.bounds ofView:button preferredEdge:NSRectEdgeMinY];
    NSWindow *popWin = self.popover.contentViewController.view.window;
    if (popWin) {
        popWin.collectionBehavior |= NSWindowCollectionBehaviorCanJoinAllSpaces | NSWindowCollectionBehaviorFullScreenAuxiliary;
        [popWin makeKeyWindow];
        [popWin makeFirstResponder:self.popoverWebView];
    }
    [NSApp activateIgnoringOtherApps:YES];
    self.pendingMacTargetPush = self.popoverWebView.isLoading;
    [self pushTargetContextToWebView:self.popoverWebView];
}

- (void)activateTargetApp {
    if (!self.targetApp || self.targetApp.terminated) return;
    SEL yieldSel = @selector(yieldActivationToApplication:);
    if ([NSApp respondsToSelector:yieldSel]) {
        ((void (*)(id, SEL, NSRunningApplication *))objc_msgSend)(NSApp, yieldSel, self.targetApp);
        [self.targetApp activateWithOptions:0];
    } else {
        [self.targetApp activateWithOptions:NSApplicationActivateIgnoringOtherApps];
    }
}

- (void)triggerQuickAutofill {
    if (self.popover.isShown) {
        [self.popover performClose:nil];
        [self activateTargetApp];
        return;
    }
    [self captureFrontmostTargetContext];
    NSStatusBarButton *button = self.statusItem.button;
    if (button) {
        [self openPopoverFromButton:button];
    }
}

- (void)togglePopover:(NSStatusBarButton *)sender {
    if (self.popover.isShown) {
        [self.popover performClose:sender];
    } else if (sender) {
        [self openPopoverFromButton:sender];
    }
}

- (void)handleStatusItemClick:(NSStatusBarButton *)sender {
    if (!self.popover.isShown) {
        [self captureFrontmostTargetContext];
    }
    NSEvent *event = [NSApp currentEvent];
    if (event.type == NSEventTypeRightMouseUp) {
        [self.statusMenu popUpMenuPositioningItem:nil atLocation:NSMakePoint(0, sender.bounds.size.height + 4) inView:sender];
        return;
    }
    [self togglePopover:sender];
}

- (BOOL)isAuthorizedWebViewMessage:(WKScriptMessage *)message {
    if (!message.frameInfo.isMainFrame) return NO;
    NSURL *expected = [NSURL URLWithString:[self resolveVaultUrl]];
    NSString *originProtocol = message.frameInfo.securityOrigin.protocol;
    NSString *originHost = message.frameInfo.securityOrigin.host;
    NSInteger originPort = message.frameInfo.securityOrigin.port;
    NSInteger expectedPort = expected.port ? expected.port.integerValue : 0;
    if (!expected || !expected.scheme.length || originHost.length == 0) return NO;
    BOOL sameScheme = [originProtocol isEqualToString:expected.scheme];
    BOOL sameHost = [originHost isEqualToString:expected.host] ||
                    ([originHost isEqualToString:@"127.0.0.1"] && [expected.host isEqualToString:@"localhost"]) ||
                    ([originHost isEqualToString:@"localhost"] && [expected.host isEqualToString:@"127.0.0.1"]);
    BOOL samePort = (expectedPort > 0) ? (originPort == expectedPort) : (originPort == 0 || originPort == 80);
    return sameScheme && sameHost && samePort;
}

- (NSInteger)writeSensitiveTextToPasteboard:(NSString *)text clearAfterSeconds:(NSInteger)seconds {
    NSPasteboard *pb = [NSPasteboard generalPasteboard];
    if (@available(macOS 10.12, *)) {
        [pb prepareForNewContentsWithOptions:NSPasteboardContentsCurrentHostOnly];
    } else {
        [pb clearContents];
    }
    [pb setString:text forType:NSPasteboardTypeString];
    [pb setString:@"" forType:@"org.nspasteboard.ConcealedType"];
    [pb setString:@"" forType:@"org.nspasteboard.TransientType"];
    NSInteger count = pb.changeCount;
    self.copiedChangeCount = count;
    if (seconds > 0) {
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(seconds * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
            NSPasteboard *laterPb = [NSPasteboard generalPasteboard];
            if (self.copiedChangeCount == count && laterPb.changeCount == count) {
                [laterPb clearContents];
                self.copiedChangeCount = 0;
            }
        });
    }
    return count;
}

- (void)postKeyEvent:(CGKeyCode)keyCode flags:(CGEventFlags)flags uniChars:(const UniChar *)chars length:(UniCharCount)len source:(CGEventSourceRef)source {
    for (int down = 1; down >= 0; down--) {
        CGEventRef ev = CGEventCreateKeyboardEvent(source, keyCode, down == 1);
        if (!ev) continue;
        if (chars) CGEventKeyboardSetUnicodeString(ev, len, chars);
        else CGEventSetFlags(ev, flags);
        CGEventPost(kCGHIDEventTap, ev);
        CFRelease(ev);
    }
}

- (void)postKeyCode:(CGKeyCode)keyCode flags:(CGEventFlags)flags {
    CGEventSourceRef source = CGEventSourceCreate(kCGEventSourceStatePrivate);
    [self postKeyEvent:keyCode flags:flags uniChars:NULL length:0 source:source];
    if (source) CFRelease(source);
}

- (void)postUnicodeString:(NSString *)str {
    if (!str.length) return;
    if ([str isEqualToString:@"\t"]) { [self postKeyCode:(CGKeyCode)kVK_Tab flags:0]; return; }
    CGEventSourceRef source = CGEventSourceCreate(kCGEventSourceStatePrivate);
    NSUInteger offset = 0;
    while (offset < str.length) {
        NSUInteger chunkLen = MIN((NSUInteger)20, str.length - offset);
        if (offset + chunkLen < str.length &&
            CFStringIsSurrogateHighCharacter([str characterAtIndex:offset + chunkLen - 1])) {
            chunkLen = MAX((NSUInteger)1, chunkLen - 1);
        }
        UniChar buf[20];
        [str getCharacters:buf range:NSMakeRange(offset, chunkLen)];
        [self postKeyEvent:0 flags:0 uniChars:buf length:(UniCharCount)chunkLen source:source];
        offset += chunkLen;
    }
    if (source) CFRelease(source);
}

- (void)clearPasteboardIfChangeCount:(NSInteger)expectedCount {
    NSPasteboard *pb = [NSPasteboard generalPasteboard];
    if (expectedCount > 0 && pb.changeCount == expectedCount) {
        [pb clearContents];
        self.copiedChangeCount = 0;
    }
}

- (BOOL)showAlertTitle:(NSString *)title message:(NSString *)msg withCancel:(BOOL)withCancel {
    NSAlert *alert = [[NSAlert alloc] init];
    alert.messageText = title;
    alert.informativeText = msg;
    [alert addButtonWithTitle:@"OK"];
    if (withCancel) [alert addButtonWithTitle:@"Cancel"];
    return [alert runModal] == NSAlertFirstButtonReturn;
}

- (void)handleAutofillMessage:(WKScriptMessage *)message {
    if (message.webView != self.popoverWebView) return;
    if (![self isAuthorizedWebViewMessage:message] || ![message.body isKindOfClass:[NSDictionary class]]) return;
    if (!self.targetApp || self.targetApp.terminated) return;

    NSDictionary *body = (NSDictionary *)message.body;
    NSString *username = [body[@"username"] isKindOfClass:[NSString class]] ? body[@"username"] : @"";
    NSString *password = [body[@"password"] isKindOfClass:[NSString class]] ? body[@"password"] : @"";
    NSString *mode = [body[@"mode"] isKindOfClass:[NSString class]] ? body[@"mode"] : @"auto";
    if (username.length > 8192 || password.length > 8192 || mode.length > 64) return;

    if (!AXIsProcessTrustedWithOptions((__bridge CFDictionaryRef)@{(__bridge id)kAXTrustedCheckOptionPrompt: @YES})) {
        NSString *fallback = password.length ? password : username;
        if (fallback.length) [self writeSensitiveTextToPasteboard:fallback clearAfterSeconds:60];
        if (self.popover.isShown) [self.popover performClose:nil];
        [self showAlertTitle:@"Quyền Accessibility chưa bật"
                     message:@"Hãy bật WebMCP Vault trong System Settings > Privacy & Security > Accessibility để dùng AutoFill. Mật khẩu đã được sao chép vào clipboard bảo mật trong 60 giây."
                  withCancel:NO];
        return;
    }

    NSUInteger gen = ++self.autofillGeneration;
    pid_t targetPid = self.targetApp.processIdentifier;
    BOOL targetIsTerm = self.targetIsTerminal;
    BOOL targetIsSec = self.targetIsSecureField;
    BOOL isSecurityAgent = [self.targetApp.bundleIdentifier isEqualToString:@"com.apple.SecurityAgent"];

    if (self.popover.isShown) [self.popover performClose:nil];
    [self activateTargetApp];

    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(140 * NSEC_PER_MSEC)), dispatch_get_main_queue(), ^{
        if (gen != self.autofillGeneration) return;
        NSRunningApplication *curFront = [[NSWorkspace sharedWorkspace] frontmostApplication];
        if (!curFront || curFront.processIdentifier != targetPid) return;

        BOOL liveIsSec = [self probeFocusedElementIsSecureForPID:targetPid];
        BOOL usePassOnly = [mode isEqualToString:@"pass_only"] || targetIsTerm || liveIsSec || targetIsSec || username.length == 0;
        NSArray<NSString *> *steps = @[];
        if (usePassOnly) steps = password.length ? @[password] : @[];
        else if (username.length && password.length) steps = @[username, @"\t", password];
        else if (username.length) steps = @[username];
        else if (password.length) steps = @[password];
        if (steps.count == 0) return;

        NSPasteboard *pb = [NSPasteboard generalPasteboard];
        NSString *savedString = nil;
        if (!isSecurityAgent && pb.changeCount != self.copiedChangeCount &&
            [pb availableTypeFromArray:@[@"org.nspasteboard.ConcealedType", @"org.nspasteboard.TransientType"]] == nil) {
            savedString = [[pb stringForType:NSPasteboardTypeString] copy];
        }

        const int64_t stepIntervalMs = 170;
        __block NSInteger expectedLastChangeCount = 0;
        __block BOOL abortedByUser = NO;

        for (NSUInteger idx = 0; idx < steps.count; idx++) {
            NSString *stepText = steps[idx];
            dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(idx * stepIntervalMs * NSEC_PER_MSEC)), dispatch_get_main_queue(), ^{
                if (gen != self.autofillGeneration || abortedByUser) return;
                NSRunningApplication *stepFront = [[NSWorkspace sharedWorkspace] frontmostApplication];
                if (!stepFront || stepFront.processIdentifier != targetPid) {
                    abortedByUser = YES;
                    [self clearPasteboardIfChangeCount:expectedLastChangeCount];
                    return;
                }
                if (isSecurityAgent) {
                    [self postUnicodeString:stepText];
                    return;
                }
                if (expectedLastChangeCount > 0 && [NSPasteboard generalPasteboard].changeCount != expectedLastChangeCount) {
                    abortedByUser = YES;
                    return;
                }
                if ([stepText isEqualToString:@"\t"]) {
                    [self postKeyCode:(CGKeyCode)kVK_Tab flags:0];
                } else {
                    expectedLastChangeCount = [self writeSensitiveTextToPasteboard:stepText clearAfterSeconds:0];
                    [self postKeyCode:(CGKeyCode)kVK_ANSI_V flags:kCGEventFlagMaskCommand];
                }
            });
        }

        if (!isSecurityAgent) {
            int64_t finishDelayMs = (int64_t)((steps.count - 1) * stepIntervalMs + 450);
            dispatch_after(dispatch_time(DISPATCH_TIME_NOW, finishDelayMs * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{
                if (gen != self.autofillGeneration || abortedByUser) return;
                NSPasteboard *laterPb = [NSPasteboard generalPasteboard];
                if (expectedLastChangeCount > 0 && laterPb.changeCount == expectedLastChangeCount) {
                    [laterPb clearContents];
                    if (savedString.length) [laterPb setString:savedString forType:NSPasteboardTypeString];
                    self.copiedChangeCount = 0;
                }
            });
        }
    });
}

- (void)userContentController:(WKUserContentController *)userContentController didReceiveScriptMessage:(WKScriptMessage *)message {
    (void)userContentController;
    if ([message.name isEqualToString:@"openFullApp"]) {
        dispatch_async(dispatch_get_main_queue(), ^{ [self showMainWindow]; });
    } else if ([message.name isEqualToString:@"autofillTarget"]) {
        [self handleAutofillMessage:message];
    } else if ([message.name isEqualToString:@"copyClipboard"]) {
        if (![self isAuthorizedWebViewMessage:message]) return;
        NSString *text = @"";
        BOOL sensitive = NO;
        if ([message.body isKindOfClass:[NSDictionary class]]) {
            NSDictionary *body = (NSDictionary *)message.body;
            if ([body[@"text"] isKindOfClass:[NSString class]]) text = body[@"text"];
            id sensVal = body[@"sensitive"];
            if ([sensVal isKindOfClass:[NSNumber class]] || [sensVal isKindOfClass:[NSString class]]) sensitive = [sensVal boolValue];
        } else if ([message.body isKindOfClass:[NSString class]]) {
            text = (NSString *)message.body;
        }
        if (text.length > 65536) return;
        if (text.length == 0) { [self clearPasteboardIfChangeCount:self.copiedChangeCount]; return; }
        if (sensitive) {
            [self writeSensitiveTextToPasteboard:text clearAfterSeconds:60];
        } else {
            NSPasteboard *pb = [NSPasteboard generalPasteboard];
            [pb clearContents];
            [pb setString:text forType:NSPasteboardTypeString];
            self.copiedChangeCount = 0;
        }
    }
}

- (void)applicationWillTerminate:(NSNotification *)notification {
    (void)notification;
    self.autofillGeneration += 1;
    if (self.globalHotKeyRef) { UnregisterEventHotKey(self.globalHotKeyRef); self.globalHotKeyRef = NULL; }
    if (self.hotKeyHandlerRef) { RemoveEventHandler(self.hotKeyHandlerRef); self.hotKeyHandlerRef = NULL; }
    [self clearPasteboardIfChangeCount:self.copiedChangeCount];
}

- (void)reloadWeb {
    self.retryCount = 0;
    [self loadWebContent];
}

- (void)openInBrowser {
    NSURL *url = [NSURL URLWithString:[self resolveVaultUrl]];
    if (url) [[NSWorkspace sharedWorkspace] openURL:url];
}

- (void)quitApp {
    [NSApp terminate:nil];
}

- (void)webView:(WKWebView *)webView runJavaScriptAlertPanelWithMessage:(NSString *)message initiatedByFrame:(WKFrameInfo *)frame completionHandler:(void (^)(void))completionHandler {
    (void)webView; (void)frame;
    [self showAlertTitle:@"WebMCP Vault" message:message withCancel:NO];
    completionHandler();
}

- (void)webView:(WKWebView *)webView runJavaScriptConfirmPanelWithMessage:(NSString *)message initiatedByFrame:(WKFrameInfo *)frame completionHandler:(void (^)(BOOL))completionHandler {
    (void)webView; (void)frame;
    completionHandler([self showAlertTitle:@"WebMCP Vault" message:message withCancel:YES]);
}

@end

int main(int argc, const char * argv[]) {
    @autoreleasepool {
        BOOL trayMode = NO;
        for (int i = 1; i < argc; i++) {
            if (strcmp(argv[i], "--tray") == 0 || strcmp(argv[i], "--background") == 0) {
                trayMode = YES;
                break;
            }
        }
        NSApplication *app = [NSApplication sharedApplication];
        AppDelegate *delegate = [[AppDelegate alloc] init];
        app.delegate = delegate;
        [app setActivationPolicy:(trayMode ? NSApplicationActivationPolicyAccessory : NSApplicationActivationPolicyRegular)];
        [app run];
    }
    return 0;
}
