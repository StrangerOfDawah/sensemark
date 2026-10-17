// Окно приложения Sensemark для Safari.
//
// Здесь скачиваются языки для бесплатного перевода: macOS разрешает скачивать
// их только из окна приложения (.translationTask), а не из расширения.
// Ещё окно подсказывает, включено ли расширение в Safari.
//
// Файл заменяет ViewController.swift из шаблона Apple. Окно по-прежнему
// создаёт Main.storyboard, а содержимое рисует SwiftUI.

import Cocoa
import SafariServices
import SwiftUI
import Translation
import WebKit

class ViewController: NSViewController {
    // Остался от шаблона Apple (связь в Main.storyboard), не используется.
    @IBOutlet var webView: WKWebView?

    override func loadView() {
        let root: AnyView
        if #available(macOS 15.0, *) {
            root = AnyView(LanguagesView())
        } else {
            root = AnyView(
                Text("Для бесплатного перевода нужна macOS 15 или новее.\nРежим OpenAI работает и так.")
                    .multilineTextAlignment(.center)
                    .padding(40)
            )
        }
        let hosting = NSHostingView(rootView: root)
        hosting.frame = NSRect(x: 0, y: 0, width: 560, height: 640)
        view = hosting
    }
}

struct LanguageRow: Identifiable, Hashable {
    let id: String // код языка, например "en" или "ja"
    let name: String
    var installed: Bool
}

@available(macOS 15.0, *)
struct LanguagesView: View {
    @State private var rows: [LanguageRow] = []
    @State private var loading = true
    @State private var downloading: String?
    @State private var configuration: TranslationSession.Configuration?
    @State private var extensionEnabled: Bool?
    @State private var filter = ""

    private static let target = Locale.Language(identifier: "ru")

    private var extensionIdentifier: String {
        (Bundle.main.bundleIdentifier ?? "Sensemark") + ".Extension"
    }

    private var visibleRows: [LanguageRow] {
        let query = filter.trimmingCharacters(in: .whitespaces).lowercased()
        guard !query.isEmpty else { return rows }
        return rows.filter { $0.name.lowercased().contains(query) || $0.id.lowercased().hasPrefix(query) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Sensemark")
                .font(.largeTitle.bold())
            Text("Перевод выделенного текста на русский прямо в Safari.")
                .foregroundStyle(.secondary)

            extensionStatus

            Divider()

            Text("Языки для бесплатного перевода")
                .font(.headline)
            Text("Скачайте языки, с которых вы читаете. Это нужно один раз — потом перевод работает без интернета, и текст не покидает Mac.")
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            TextField("Найти язык", text: $filter)
                .textFieldStyle(.roundedBorder)

            if loading {
                ProgressView()
                    .frame(maxWidth: .infinity, alignment: .center)
                    .padding()
            } else {
                List(visibleRows) { row in
                    HStack {
                        Text(row.name)
                        Spacer()
                        if row.installed {
                            Label("Скачан", systemImage: "checkmark.circle.fill")
                                .foregroundStyle(.green)
                        } else if downloading == row.id {
                            ProgressView().controlSize(.small)
                        } else {
                            Button("Скачать") { download(row) }
                                .disabled(downloading != nil)
                        }
                    }
                    .padding(.vertical, 2)
                }
            }
        }
        .padding(24)
        .frame(minWidth: 520, minHeight: 600)
        .task {
            await refresh()
            await refreshExtensionState()
        }
        .translationTask(configuration) { session in
            // macOS сама показывает окно с предложением скачать язык.
            do {
                try await session.prepareTranslation()
            } catch {
                // Человек отменил скачивание — просто обновим список.
            }
            await finishDownload()
        }
    }

    @ViewBuilder
    private var extensionStatus: some View {
        HStack(spacing: 10) {
            switch extensionEnabled {
            case .some(true):
                Label("Расширение включено в Safari", systemImage: "checkmark.seal.fill")
                    .foregroundStyle(.green)
            case .some(false):
                Label("Расширение выключено в Safari", systemImage: "exclamationmark.triangle.fill")
                    .foregroundStyle(.orange)
            case .none:
                Label("Проверяю, включено ли расширение…", systemImage: "puzzlepiece.extension")
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Button("Настройки Safari…") {
                SFSafariApplication.showPreferencesForExtension(withIdentifier: extensionIdentifier) { _ in }
            }
        }
    }

    private func download(_ row: LanguageRow) {
        downloading = row.id
        let next = TranslationSession.Configuration(
            source: Locale.Language(identifier: row.id),
            target: Self.target
        )
        // Повторное нажатие для той же пары должно запускать задачу заново.
        if configuration?.source == next.source {
            configuration?.invalidate()
        } else {
            configuration = next
        }
    }

    @MainActor
    private func finishDownload() async {
        downloading = nil
        await refresh()
    }

    @MainActor
    private func refresh() async {
        let availability = LanguageAvailability()
        let russian = Locale(identifier: "ru")
        var seen = Set<String>()
        var result: [LanguageRow] = []
        for language in await availability.supportedLanguages {
            let id = language.minimalIdentifier
            guard language.languageCode?.identifier != "ru", seen.insert(id).inserted else { continue }
            let status = await availability.status(from: language, to: Self.target)
            guard status != .unsupported else { continue }
            let name = russian.localizedString(forIdentifier: id) ?? id
            result.append(LanguageRow(id: id, name: name.prefix(1).uppercased() + name.dropFirst(), installed: status == .installed))
        }
        rows = result.sorted { $0.name.localizedCompare($1.name) == .orderedAscending }
        loading = false
    }

    @MainActor
    private func refreshExtensionState() async {
        let identifier = extensionIdentifier
        let enabled: Bool? = await withCheckedContinuation { continuation in
            SFSafariExtensionManager.getStateOfSafariExtension(withIdentifier: identifier) { state, _ in
                continuation.resume(returning: state?.isEnabled)
            }
        }
        extensionEnabled = enabled ?? false
    }
}
