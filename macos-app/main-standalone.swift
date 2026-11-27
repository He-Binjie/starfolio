import AppKit
import Carbon
import Darwin
import Foundation
import WebKit

private let kHotKeySignature: OSType = 0x4B424353 // 'KBCS'
private let kHotKeyID: UInt32 = 1

private weak var globalAppDelegate: AppDelegate?

private func carbonHotKeyHandler(
    _ nextHandler: EventHandlerCallRef?,
    _ event: EventRef?,
    _ userData: UnsafeMutableRawPointer?
) -> OSStatus {
    DispatchQueue.main.async {
        globalAppDelegate?.toggleMainWindow()
    }
    return noErr
}

private func findAvailablePort(startPort: UInt16 = 18766, endPort: UInt16 = 18799) -> UInt16 {
    for port in startPort...endPort {
        let fd = Darwin.socket(AF_INET, SOCK_STREAM, 0)
        if fd < 0 { continue }
        var reuse: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &reuse, socklen_t(MemoryLayout<Int32>.size))
        var addr = sockaddr_in()
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = port.bigEndian
        addr.sin_addr = in_addr(s_addr: inet_addr("127.0.0.1"))
        let res = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        Darwin.close(fd)
        if res == 0 {
            return port
        }
    }
    return startPort
}

final class NativeWebView: WKWebView {
    override init(frame: CGRect, configuration: WKWebViewConfiguration) {
        super.init(frame: frame, configuration: configuration)
        registerForDraggedTypes([.fileURL])
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        registerForDraggedTypes([.fileURL])
    }

    private func droppedItemPaths(from sender: NSDraggingInfo) -> [String] {
        guard let urls = sender.draggingPasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL] else {
            return []
        }
        var items: [String] = []
        let fm = FileManager.default
        for url in urls {
            if fm.fileExists(atPath: url.path) {
                items.append(url.path)
            }
        }
        return items
    }

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        let items = droppedItemPaths(from: sender)
        if !items.isEmpty {
            evaluateJavaScript("window.__kbOnFolderDragState && window.__kbOnFolderDragState(true)", completionHandler: nil)
            return .copy
        }
        return super.draggingEntered(sender)
    }

    override func draggingExited(_ sender: NSDraggingInfo?) {
        evaluateJavaScript("window.__kbOnFolderDragState && window.__kbOnFolderDragState(false)", completionHandler: nil)
        super.draggingExited(sender)
    }

    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        let items = droppedItemPaths(from: sender)
        evaluateJavaScript("window.__kbOnFolderDragState && window.__kbOnFolderDragState(false)", completionHandler: nil)
        if !items.isEmpty {
            if let data = try? JSONSerialization.data(withJSONObject: items),
               let json = String(data: data, encoding: .utf8) {
                evaluateJavaScript("window.__kbOnFolderDropped && window.__kbOnFolderDropped(\(json))", completionHandler: nil)
            }
            return true
        }
        return super.performDragOperation(sender)
    }

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        if event.modifierFlags.contains(.command) {
            let key = event.charactersIgnoringModifiers?.lowercased() ?? ""
            if key == "k" {
                evaluateJavaScript("window.__kbOpenCmdK && window.__kbOpenCmdK()", completionHandler: nil)
                return true
            }
            if key == "f" {
                evaluateJavaScript("window.__kbOpenDocFind && window.__kbOpenDocFind()", completionHandler: nil)
                return true
            }
            if key == "\\" {
                evaluateJavaScript("window.__kbToggleSidebar && window.__kbToggleSidebar()", completionHandler: nil)
                return true
            }
            if key == "," {
                evaluateJavaScript("window.__kbOpenSettings && window.__kbOpenSettings()", completionHandler: nil)
                return true
            }
            if ["1", "2", "3", "4"].contains(key) {
                evaluateJavaScript("window.__kbSwitchTab && window.__kbSwitchTab('\(key)')", completionHandler: nil)
                return true
            }
        }
        return super.performKeyEquivalent(with: event)
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKScriptMessageHandler, WKNavigationDelegate {
    private var window: NSWindow!
    private var webView: NativeWebView!
    private var statusItem: NSStatusItem!
    private var statusInfoMenuItem: NSMenuItem!
    private var hotKeyRef: EventHotKeyRef?
    private var isQuitting = false

    private var serverPort: UInt16 = 18766
    private var serverURL: URL!
    private var healthURL: URL!
    private var backendProcess: Process?
    private var logFileHandle: FileHandle?

    func applicationDidFinishLaunching(_ notification: Notification) {
        globalAppDelegate = self
        NSApp.setActivationPolicy(.regular)

        serverPort = findAvailablePort(startPort: 18766, endPort: 18799)
        serverURL = URL(string: "http://127.0.0.1:\(serverPort)/")!
        healthURL = URL(string: "http://127.0.0.1:\(serverPort)/api/index/status")!

        setupMainMenu()
        setupStatusBar()
        setupWindow()
        registerGlobalHotKey()
        showLoadingSplash()
        startEmbeddedBackend()
        waitForBackendAndLoad()
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showMainWindow()
        return true
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        isQuitting = true
        stopEmbeddedBackend()
        return .terminateNow
    }

    func applicationWillTerminate(_ notification: Notification) {
        stopEmbeddedBackend()
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        if isQuitting {
            return true
        }
        // Hide to Menu Bar so Option+Space summons instantly
        window.orderOut(nil)
        return false
    }

    // MARK: - Embedded Standalone Backend Lifecycle
    private func appSupportDir() -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        let dir = base.appendingPathComponent("KBConsole", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    private func startEmbeddedBackend() {
        guard let resURL = Bundle.main.resourceURL else { return }
        let backendBin = resURL
            .appendingPathComponent("backend", isDirectory: true)
            .appendingPathComponent("kb-backend")
        guard FileManager.default.isExecutableFile(atPath: backendBin.path) else {
            showErrorPage("应用内置引擎缺失：\(backendBin.path)")
            return
        }

        let dataDir = appSupportDir()
        let logURL = dataDir.appendingPathComponent("backend.log")
        if !FileManager.default.fileExists(atPath: logURL.path) {
            FileManager.default.createFile(atPath: logURL.path, contents: nil)
        }
        logFileHandle = try? FileHandle(forWritingTo: logURL)
        logFileHandle?.truncateFile(atOffset: 0)

        let proc = Process()
        proc.executableURL = backendBin
        proc.currentDirectoryURL = dataDir

        var env = ProcessInfo.processInfo.environment
        env["KB_CONSOLE_EDITION"] = "standalone"
        env["KB_CONSOLE_PORT"] = String(serverPort)
        env["KB_CONSOLE_DATA_DIR"] = dataDir.path
        env["KB_CONSOLE_FRONTEND_DIR"] = resURL.appendingPathComponent("frontend-dist").path
        env["KB_CONSOLE_BUNDLED_MODEL_DIR"] = resURL.appendingPathComponent("models").path
        env["KB_CONSOLE_SAMPLE_KB_DIR"] = resURL.appendingPathComponent("sample-kb").path
        env["PYTHONUNBUFFERED"] = "1"
        proc.environment = env

        if let fh = logFileHandle {
            proc.standardOutput = fh
            proc.standardError = fh
        }

        do {
            try proc.run()
            backendProcess = proc
        } catch {
            showErrorPage("启动本地知识库引擎失败：\(error.localizedDescription)")
        }
    }

    private func stopEmbeddedBackend() {
        if let proc = backendProcess, proc.isRunning {
            proc.terminate()
            let deadline = Date().addingTimeInterval(1.5)
            while proc.isRunning && Date() < deadline {
                usleep(50_000)
            }
            if proc.isRunning {
                kill(proc.processIdentifier, SIGKILL)
            }
        }
        backendProcess = nil
        try? logFileHandle?.close()
        logFileHandle = nil
    }

    // MARK: - Window & WebView
    private func setupWindow() {
        let style: NSWindow.StyleMask = [
            .titled,
            .closable,
            .miniaturizable,
            .resizable,
            .fullSizeContentView,
        ]
        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1360, height: 860),
            styleMask: style,
            backing: .buffered,
            defer: false
        )
        window.title = "星海拾卷"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.isMovableByWindowBackground = false
        window.minSize = NSSize(width: 960, height: 620)
        window.center()
        window.setFrameAutosaveName("KBConsoleStandaloneWindow")
        window.delegate = self

        let userContent = WKUserContentController()
        userContent.add(self, name: "kbNative")
        let bootScript = WKUserScript(
            source: "window.__KB_NATIVE_MAC__ = true;",
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        )
        userContent.addUserScript(bootScript)

        let webCfg = WKWebViewConfiguration()
        webCfg.userContentController = userContent
        webCfg.preferences.setValue(true, forKey: "developerExtrasEnabled")

        let bgEffect = NSVisualEffectView(frame: window.contentView!.bounds)
        bgEffect.autoresizingMask = [.width, .height]
        bgEffect.material = .sidebar
        bgEffect.blendingMode = .behindWindow
        bgEffect.state = .active
        window.contentView?.addSubview(bgEffect)

        webView = NativeWebView(frame: window.contentView!.bounds, configuration: webCfg)
        webView.autoresizingMask = [.width, .height]
        webView.navigationDelegate = self
        webView.setValue(false, forKey: "drawsBackground")

        window.contentView?.addSubview(webView)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func showLoadingSplash() {
        let html = """
        <!doctype html>
        <html><head><meta charset="utf-8"><style>
          body { margin:0; height:100vh; display:flex; align-items:center; justify-content:center;
            font-family:-apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif;
            background:#f6f7f9; color:#0f172a; }
          @media (prefers-color-scheme: dark) {
            body { background:#151619; color:#f1f5f9; }
            .sub { color:#94a3b8 !important; }
          }
          .box { text-align:center; }
          .dot { width:10px; height:10px; border-radius:50%; background:#2563eb; display:inline-block;
            margin-bottom:14px; animation:pulse 1.2s infinite ease-in-out; }
          @keyframes pulse { 0%,100% { transform:scale(1); opacity:.45; } 50% { transform:scale(1.4); opacity:1; } }
          h3 { margin:0 0 6px; font-weight:600; font-size:16px; }
          .sub { margin:0; font-size:12.5px; color:#64748b; }
        </style></head>
        <body><div class="box">
          <div class="dot"></div>
          <h3>星海拾卷正在启动…</h3>
          <p class="sub">正在初始化本地只读检索引擎（全程离线，不修改原文件）</p>
        </div></body></html>
        """
        webView.loadHTMLString(html, baseURL: nil)
    }

    private func showErrorPage(_ message: String) {
        let safe = message.replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: ">", with: "&gt;")
        let logPath = appSupportDir().appendingPathComponent("backend.log").path
        let html = """
        <!doctype html>
        <html><head><meta charset="utf-8"><style>
          body { font-family:-apple-system,sans-serif; padding:60px; background:#f8fafc; color:#0f172a; }
          @media (prefers-color-scheme: dark) { body { background:#1c1d21; color:#f1f5f9; } }
          code { background:rgba(148,163,184,0.18); padding:2px 6px; border-radius:4px; }
        </style></head>
        <body>
          <h2>本地引擎启动异常</h2>
          <p>\(safe)</p>
          <p style="font-size:13px;opacity:0.75;">排查日志：<code>\(logPath)</code></p>
        </body></html>
        """
        DispatchQueue.main.async {
            self.webView.loadHTMLString(html, baseURL: nil)
        }
    }

    private func waitForBackendAndLoad(attempt: Int = 0) {
        var req = URLRequest(url: healthURL)
        req.timeoutInterval = 1.0
        URLSession.shared.dataTask(with: req) { [weak self] _, response, _ in
            guard let self = self else { return }
            if let http = response as? HTTPURLResponse, http.statusCode == 200 {
                DispatchQueue.main.async {
                    self.webView.load(URLRequest(url: self.serverURL))
                }
                return
            }
            if let proc = self.backendProcess, !proc.isRunning {
                self.showErrorPage("内置后端提前退出（退出码 \(proc.terminationStatus)）。请查看 backend.log。")
                return
            }
            if attempt < 45 {
                DispatchQueue.global().asyncAfter(deadline: .now() + 0.35) {
                    self.waitForBackendAndLoad(attempt: attempt + 1)
                }
            } else {
                self.showErrorPage("等待本地引擎就绪超时（127.0.0.1:\(self.serverPort)）。")
            }
        }.resume()
    }

    // MARK: - JS <-> Native Bridge
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        switch type {
        case "theme":
            if let value = body["value"] as? String {
                applyAppearance(value)
            }
        case "dragWindow":
            if let event = NSApp.currentEvent {
                window.performDrag(with: event)
            }
        case "status":
            let docs = body["docs"] as? Int ?? 0
            statusInfoMenuItem.title = "本机只读索引：\(docs) 份文档"
        case "pickFolder":
            openPathPicker(mode: "folder")
        case "pickFiles":
            openPathPicker(mode: "files")
        case "pickAny":
            openPathPicker(mode: "any")
        default:
            break
        }
    }

    private func openPathPicker(mode: String) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = true
        panel.canCreateDirectories = false
        switch mode {
        case "files":
            panel.title = "选择本地文档文件（可多选，纯本地只读，不上传）"
            panel.prompt = "拾取选中文件"
            panel.canChooseDirectories = false
            panel.canChooseFiles = true
        case "folder":
            panel.title = "选择要接入的文件夹（可多选，纯本地只读，不改原件）"
            panel.prompt = "接入文件夹"
            panel.canChooseDirectories = true
            panel.canChooseFiles = false
        default:
            panel.title = "选择本地文件或文件夹（可多选，纯本地只读，不上传）"
            panel.prompt = "拾取并索引"
            panel.canChooseDirectories = true
            panel.canChooseFiles = true
        }

        panel.beginSheetModal(for: window) { [weak self] resp in
            guard resp == .OK, let self = self else { return }
            let paths = panel.urls.map { $0.path }
            guard !paths.isEmpty else { return }
            if let jsonData = try? JSONSerialization.data(withJSONObject: paths),
               let arrStr = String(data: jsonData, encoding: .utf8) {
                let js = "if (window.__kbOnPathsPicked) { window.__kbOnPathsPicked(\(arrStr)); } else if (window.__kbOnFolderPicked) { window.__kbOnFolderPicked((\(arrStr))[0]); }"
                self.webView.evaluateJavaScript(js, completionHandler: nil)
            }
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let url = navigationAction.request.url {
            if url.host == "127.0.0.1" || url.host == "localhost" || url.scheme == "about" {
                decisionHandler(.allow)
                return
            }
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    private func applyAppearance(_ pref: String) {
        switch pref {
        case "dark":
            NSApp.appearance = NSAppearance(named: .darkAqua)
        case "light":
            NSApp.appearance = NSAppearance(named: .aqua)
        default:
            NSApp.appearance = nil
        }
    }

    // MARK: - Menu Bar Resident Item
    private func setupStatusBar() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let btn = statusItem.button {
            if let img = NSImage(systemSymbolName: "books.vertical.fill", accessibilityDescription: "星海拾卷") {
                img.isTemplate = true
                btn.image = img
            } else {
                btn.title = "KB"
            }
            btn.toolTip = "星海拾卷 (⌥Space 呼出)"
        }

        let menu = NSMenu()
        statusInfoMenuItem = NSMenuItem(title: "本地只读引擎 · 启动中", action: nil, keyEquivalent: "")
        statusInfoMenuItem.isEnabled = false
        menu.addItem(statusInfoMenuItem)
        menu.addItem(.separator())

        let toggleItem = NSMenuItem(title: "显示 / 隐藏主窗口 (⌥Space)", action: #selector(toggleMainWindow), keyEquivalent: "")
        toggleItem.target = self
        menu.addItem(toggleItem)

        let jumpItem = NSMenuItem(title: "快速跳转文档 (⌘K)", action: #selector(openQuickJump), keyEquivalent: "")
        jumpItem.target = self
        menu.addItem(jumpItem)

        let settingsItem = NSMenuItem(title: "设置 · 文件夹与模型 (⌘,)", action: #selector(openSettings), keyEquivalent: "")
        settingsItem.target = self
        menu.addItem(settingsItem)

        let guideItem = NSMenuItem(title: "快速上手引导", action: #selector(openGuide), keyEquivalent: "")
        guideItem.target = self
        menu.addItem(guideItem)

        let syncItem = NSMenuItem(title: "增量同步索引", action: #selector(triggerSync), keyEquivalent: "")
        syncItem.target = self
        menu.addItem(syncItem)

        menu.addItem(.separator())

        let themeItem = NSMenuItem(title: "外观主题", action: nil, keyEquivalent: "")
        let themeSub = NSMenu()
        for (title, val) in [("跟随系统自动切换", "system"), ("浅色模式", "light"), ("深色模式", "dark")] {
            let mi = NSMenuItem(title: title, action: #selector(selectThemeFromMenu(_:)), keyEquivalent: "")
            mi.target = self
            mi.representedObject = val
            themeSub.addItem(mi)
        }
        themeItem.submenu = themeSub
        menu.addItem(themeItem)

        let browserItem = NSMenuItem(title: "在浏览器中打开", action: #selector(openInBrowser), keyEquivalent: "")
        browserItem.target = self
        menu.addItem(browserItem)

        menu.addItem(.separator())

        let quitItem = NSMenuItem(title: "退出 星海拾卷", action: #selector(quitApp), keyEquivalent: "q")
        quitItem.target = self
        menu.addItem(quitItem)

        statusItem.menu = menu
    }

    // MARK: - Main macOS Menu
    private func setupMainMenu() {
        let mainMenu = NSMenu()

        let appMenuItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "关于 星海拾卷", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        let prefs = NSMenuItem(title: "设置…", action: #selector(openSettings), keyEquivalent: ",")
        prefs.target = self
        appMenu.addItem(prefs)
        let guide = NSMenuItem(title: "快速上手引导", action: #selector(openGuide), keyEquivalent: "")
        guide.target = self
        appMenu.addItem(guide)
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "隐藏 星海拾卷", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let hideOthers = appMenu.addItem(withTitle: "隐藏其他", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        hideOthers.keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(.separator())
        let quit = NSMenuItem(title: "退出 星海拾卷", action: #selector(quitApp), keyEquivalent: "q")
        quit.target = self
        appMenu.addItem(quit)
        appMenuItem.submenu = appMenu
        mainMenu.addItem(appMenuItem)

        let editMenuItem = NSMenuItem()
        let editMenu = NSMenu(title: "编辑")
        editMenu.addItem(withTitle: "撤销", action: Selector(("undo:")), keyEquivalent: "z")
        editMenu.addItem(withTitle: "重做", action: Selector(("redo:")), keyEquivalent: "Z")
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: "剪切", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "拷贝", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editMenuItem.submenu = editMenu
        mainMenu.addItem(editMenuItem)

        let viewMenuItem = NSMenuItem()
        let viewMenu = NSMenu(title: "视图")
        let cmdk = NSMenuItem(title: "快速跳转", action: #selector(openQuickJump), keyEquivalent: "k")
        cmdk.target = self
        viewMenu.addItem(cmdk)
        let reload = NSMenuItem(title: "重新加载", action: #selector(reloadPage), keyEquivalent: "r")
        reload.target = self
        viewMenu.addItem(reload)
        viewMenu.addItem(.separator())
        let zoomIn = NSMenuItem(title: "放大", action: #selector(zoomInView), keyEquivalent: "+")
        zoomIn.target = self
        viewMenu.addItem(zoomIn)
        let zoomOut = NSMenuItem(title: "缩小", action: #selector(zoomOutView), keyEquivalent: "-")
        zoomOut.target = self
        viewMenu.addItem(zoomOut)
        let zoomReset = NSMenuItem(title: "实际大小", action: #selector(zoomResetView), keyEquivalent: "0")
        zoomReset.target = self
        viewMenu.addItem(zoomReset)
        viewMenu.addItem(.separator())
        let fullScreen = NSMenuItem(title: "进入全屏幕", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        fullScreen.keyEquivalentModifierMask = [.command, .control]
        viewMenu.addItem(fullScreen)
        viewMenuItem.submenu = viewMenu
        mainMenu.addItem(viewMenuItem)

        let winMenuItem = NSMenuItem()
        let winMenu = NSMenu(title: "窗口")
        winMenu.addItem(withTitle: "最小化", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        winMenu.addItem(withTitle: "关闭窗口（隐藏到菜单栏）", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        winMenuItem.submenu = winMenu
        mainMenu.addItem(winMenuItem)

        NSApp.mainMenu = mainMenu
    }

    // MARK: - Global Hotkey (Option + Space)
    private func registerGlobalHotKey() {
        var eventSpec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(), carbonHotKeyHandler, 1, &eventSpec, nil, nil)

        let hotKeyID = EventHotKeyID(signature: kHotKeySignature, id: kHotKeyID)
        RegisterEventHotKey(
            UInt32(kVK_Space),
            UInt32(optionKey),
            hotKeyID,
            GetApplicationEventTarget(),
            0,
            &hotKeyRef
        )
    }

    // MARK: - Actions
    @objc func toggleMainWindow() {
        if window.isVisible && NSApp.isActive {
            window.orderOut(nil)
        } else {
            showMainWindow()
        }
    }

    @objc func showMainWindow() {
        if window.isMiniaturized {
            window.deminiaturize(nil)
        }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    @objc func openQuickJump() {
        showMainWindow()
        webView.evaluateJavaScript("window.__kbOpenCmdK && window.__kbOpenCmdK()", completionHandler: nil)
    }

    @objc func openSettings() {
        showMainWindow()
        webView.evaluateJavaScript("window.__kbOpenSettings && window.__kbOpenSettings()", completionHandler: nil)
    }

    @objc func openGuide() {
        showMainWindow()
        webView.evaluateJavaScript("window.__kbOpenGuide && window.__kbOpenGuide()", completionHandler: nil)
    }

    @objc func triggerSync() {
        webView.evaluateJavaScript("window.__kbTriggerSync && window.__kbTriggerSync()", completionHandler: nil)
    }

    @objc func selectThemeFromMenu(_ sender: NSMenuItem) {
        guard let val = sender.representedObject as? String else { return }
        applyAppearance(val)
        webView.evaluateJavaScript("window.__kbSetTheme && window.__kbSetTheme('\(val)')", completionHandler: nil)
    }

    @objc func openInBrowser() {
        NSWorkspace.shared.open(serverURL)
    }

    @objc func reloadPage() {
        webView.reload()
    }

    @objc func zoomInView() {
        webView.pageZoom = min(1.5, webView.pageZoom + 0.1)
    }

    @objc func zoomOutView() {
        webView.pageZoom = max(0.75, webView.pageZoom - 0.1)
    }

    @objc func zoomResetView() {
        webView.pageZoom = 1.0
    }

    @objc func quitApp() {
        isQuitting = true
        NSApp.terminate(nil)
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
