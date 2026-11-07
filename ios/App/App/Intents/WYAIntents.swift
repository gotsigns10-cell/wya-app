import AppIntents
import CoreLocation

/// WYA App Intents — Siri & Shortcuts Integration
/// Phase v4.0: SIRI-01, SIRI-02, SIRI-03
/// (c) Universoul LLC | Santa Barbara, CA | 2026

// MARK: - Find Food Trucks Intent (SIRI-01)
@available(iOS 16.0, *)
struct FindFoodTrucksIntent: AppIntent {
    static var title: LocalizedStringResource = "Find Food Trucks"
    static var description = IntentDescription("Find food trucks near you")
    static var openAppWhenRun: Bool = true

    @Parameter(title: "Category", default: "all")
    var category: String?

    func perform() async throws -> some IntentResult & ProvidesDialog & OpensIntent {
        // Opens WYA app with food truck filter
        return .result(
            dialog: "Opening WYA to find food trucks near you...",
            opensIntent: OpenWYAMapIntent()
        )
    }
}

// MARK: - Track Order Intent (SIRI-02)
@available(iOS 16.0, *)
struct TrackOrderIntent: AppIntent {
    static var title: LocalizedStringResource = "Track My Order"
    static var description = IntentDescription("Track your current WYA order")
    static var openAppWhenRun: Bool = true

    @Parameter(title: "Order Number")
    var orderNumber: String?

    func perform() async throws -> some IntentResult & ProvidesDialog {
        // If order number provided, deep link to it
        // Otherwise opens to orders list
        let message = orderNumber != nil ?
            "Opening order \(orderNumber!)..." :
            "Opening your recent orders..."
        return .result(dialog: "\(message)")
    }
}

// MARK: - What's Open Intent (SIRI-03)
@available(iOS 16.0, *)
struct WhatsOpenIntent: AppIntent {
    static var title: LocalizedStringResource = "What's Open Near Me"
    static var description = IntentDescription("See which vendors are open near you right now")
    static var openAppWhenRun: Bool = true

    func perform() async throws -> some IntentResult & ProvidesDialog {
        // Fetches live vendor count and opens app
        do {
            let count = try await WYAService.shared.getLiveVendorCount()
            if count > 0 {
                return .result(dialog: "\(count) vendor\(count > 1 ? "s" : "") open near you. Opening WYA...")
            } else {
                return .result(dialog: "No vendors open right now. Check back soon!")
            }
        } catch {
            return .result(dialog: "Opening WYA to see what's open...")
        }
    }
}

// MARK: - Open WYA Map Intent (internal)
@available(iOS 16.0, *)
struct OpenWYAMapIntent: AppIntent {
    static var title: LocalizedStringResource = "Open WYA Map"
    static var description = IntentDescription("Open the WYA live vendor map")
    static var openAppWhenRun: Bool = true

    func perform() async throws -> some IntentResult {
        return .result()
    }
}

// MARK: - Reorder Intent
@available(iOS 16.0, *)
struct ReorderIntent: AppIntent {
    static var title: LocalizedStringResource = "Reorder from WYA"
    static var description = IntentDescription("Reorder from your favorite vendor")
    static var openAppWhenRun: Bool = true

    @Parameter(title: "Vendor Name")
    var vendorName: String?

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let message = vendorName != nil ?
            "Opening \(vendorName!) for reorder..." :
            "Opening your favorite vendors..."
        return .result(dialog: "\(message)")
    }
}

// MARK: - WYA Service (API calls)
@available(iOS 16.0, *)
class WYAService {
    static let shared = WYAService()
    private let baseURL = "https://wya.digisigns.link"

    func getLiveVendorCount() async throws -> Int {
        guard let url = URL(string: "\(baseURL)/api/live-stats") else {
            throw WYAError.invalidURL
        }

        let (data, _) = try await URLSession.shared.data(from: url)

        if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let count = json["active_vendors"] as? Int {
            return count
        }

        return 0
    }

    enum WYAError: Error {
        case invalidURL
        case networkError
    }
}

// MARK: - App Shortcuts Provider
@available(iOS 16.0, *)
struct WYAShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: FindFoodTrucksIntent(),
            phrases: [
                "Find food trucks with \(.applicationName)",
                "Find food trucks near me",
                "Show me food trucks",
                "What food trucks are nearby"
            ],
            shortTitle: "Find Food Trucks",
            systemImageName: "truck.box.fill"
        )
        AppShortcut(
            intent: TrackOrderIntent(),
            phrases: [
                "Track my order with \(.applicationName)",
                "Track my \(.applicationName) order",
                "Where's my order",
                "Order status"
            ],
            shortTitle: "Track Order",
            systemImageName: "shippingbox"
        )
        AppShortcut(
            intent: WhatsOpenIntent(),
            phrases: [
                "What's open near me with \(.applicationName)",
                "What's open on \(.applicationName)",
                "Which vendors are open",
                "Who's open near me"
            ],
            shortTitle: "What's Open",
            systemImageName: "storefront"
        )
        AppShortcut(
            intent: ReorderIntent(),
            phrases: [
                "Reorder with \(.applicationName)",
                "Order again from \(.applicationName)",
                "Reorder my last order"
            ],
            shortTitle: "Reorder",
            systemImageName: "arrow.counterclockwise.circle"
        )
    }
}
