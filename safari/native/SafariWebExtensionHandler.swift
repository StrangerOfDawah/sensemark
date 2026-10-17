// Нативная часть расширения Sensemark для Safari.
//
// background.js присылает сюда сообщения вида {op: ..., ...}:
//   detect       — определить язык текста (NaturalLanguage);
//   availability — скачан ли язык для перевода на русский (Translation);
//   translate    — перевести текст системным переводчиком Apple, на устройстве;
//   openApp      — открыть приложение Sensemark, где скачиваются языки.
// Ответ всегда словарь с ключом "ok"; формат совпадает с тем, что ждёт
// createAppleBridge в builtin-translator.js.

import AppKit
import NaturalLanguage
import SafariServices
import Translation
import os

final class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    func beginRequest(with context: NSExtensionContext) {
        let item = context.inputItems.first as? NSExtensionItem
        let message = item?.userInfo?[SFExtensionMessageKey] as? [String: Any] ?? [:]
        let request = NativeRequest(message)
        let box = ContextBox(context)

        Task {
            let reply = await NativeBridge.handle(request)
            let response = NSExtensionItem()
            response.userInfo = [SFExtensionMessageKey: reply]
            box.context.completeRequest(returningItems: [response], completionHandler: nil)
        }
    }
}

/// NSExtensionContext не помечен как Sendable — переносим его в задачу явно.
private final class ContextBox: @unchecked Sendable {
    let context: NSExtensionContext
    init(_ context: NSExtensionContext) { self.context = context }
}

struct NativeRequest: Sendable {
    let op: String
    let text: String
    let source: String
    let target: String

    init(_ message: [String: Any]) {
        op = message["op"] as? String ?? ""
        text = message["text"] as? String ?? ""
        source = message["source"] as? String ?? ""
        target = message["target"] as? String ?? "ru"
    }
}

enum NativeBridge {
    private static let logger = Logger(subsystem: "Sensemark", category: "native")

    static func handle(_ request: NativeRequest) async -> [String: Any] {
        switch request.op {
        case "detect":
            return detect(request.text)
        case "availability":
            return await availability(source: request.source, target: request.target)
        case "translate":
            return await translate(request)
        case "openApp":
            let opened = await openApp()
            return opened ? ["ok": true] : ["ok": false, "code": "failed"]
        default:
            return ["ok": false, "code": "failed", "error": "unknown op: \(request.op)"]
        }
    }

    // MARK: - Определение языка

    /// Тот же формат, что у chrome.i18n.detectLanguage:
    /// {isReliable, languages: [{language, percentage}]}.
    static func detect(_ text: String) -> [String: Any] {
        let recognizer = NLLanguageRecognizer()
        recognizer.processString(text)
        let hypotheses = recognizer.languageHypotheses(withMaximum: 3).sorted { $0.value > $1.value }
        let languages: [[String: Any]] = hypotheses.map { hypothesis in
            ["language": hypothesis.key.rawValue, "percentage": Int((hypothesis.value * 100).rounded())]
        }
        // На одном-двух словах любой определитель ошибается — помечаем
        // такой ответ как ненадёжный, как это делает Chrome.
        let top = hypotheses.first?.value ?? 0
        let reliable = top >= 0.8 && text.count >= 20
        return ["ok": true, "isReliable": reliable, "languages": languages]
    }

    // MARK: - Наличие языка

    static func availability(source: String, target: String) async -> [String: Any] {
        guard #available(macOS 15.0, *) else {
            return ["ok": false, "code": "unavailable"]
        }
        let status = await LanguageAvailability().status(
            from: Locale.Language(identifier: source),
            to: Locale.Language(identifier: target)
        )
        switch status {
        case .installed:
            return ["ok": true, "status": "installed"]
        case .supported:
            return ["ok": true, "status": "supported"]
        case .unsupported:
            return ["ok": true, "status": "unsupported"]
        @unknown default:
            return ["ok": true, "status": "unsupported"]
        }
    }

    // MARK: - Перевод

    static func translate(_ request: NativeRequest) async -> [String: Any] {
        // Переводить без окна (из расширения) macOS умеет с версии 26.4.
        guard #available(macOS 26.4, *) else {
            return ["ok": false, "code": "unavailable"]
        }
        do {
            let session = TranslationSession(
                installedSource: Locale.Language(identifier: request.source),
                target: Locale.Language(identifier: request.target),
                preferredStrategy: .lowLatency
            )
            let response = try await session.translate(request.text)
            return ["ok": true, "text": response.targetText]
        } catch {
            logger.error("translate failed: \(String(describing: error), privacy: .public)")
            // Язык могли удалить в Системных настройках — тогда предлагаем скачать.
            let check = await availability(source: request.source, target: request.target)
            if check["status"] as? String == "supported" {
                return ["ok": false, "code": "needs-download"]
            }
            return ["ok": false, "code": "failed", "error": String(describing: error)]
        }
    }

    // MARK: - Приложение Sensemark

    /// Расширение лежит внутри приложения:
    /// Sensemark.app/Contents/PlugIns/Sensemark Extension.appex
    @MainActor
    static func openApp() async -> Bool {
        let appURL = Bundle.main.bundleURL
            .deletingLastPathComponent() // PlugIns
            .deletingLastPathComponent() // Contents
            .deletingLastPathComponent() // Sensemark.app
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = true
        do {
            _ = try await NSWorkspace.shared.openApplication(at: appURL, configuration: configuration)
            return true
        } catch {
            logger.error("open app failed: \(String(describing: error), privacy: .public)")
            return false
        }
    }
}
