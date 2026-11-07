import Foundation

/// SoulAPI — Bridge to THE SOUL backend
/// Handles all communication between iOS app and Soul services
/// (c) Universoul LLC | Santa Barbara, CA | 2026-11-03

class SoulAPI {
    static let shared = SoulAPI()

    private let baseURL = "https://cmd.digisigns.link"
    private var portalSecret: String? {
        // Load from Keychain in production
        return ProcessInfo.processInfo.environment["PORTAL_SECRET"]
    }

    private init() {}

    /// Send a chat message to Soul
    /// - Parameters:
    ///   - message: The message to send
    ///   - userId: User identifier (defaults to "ios-app")
    /// - Returns: Soul's response text
    func chat(message: String, userId: String = "ios-app") async throws -> String {
        let url = URL(string: "\(baseURL)/chat/quick")!
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        if let secret = portalSecret {
            request.setValue(secret, forHTTPHeaderField: "X-Portal-Secret")
        }

        let body: [String: Any] = [
            "message": message,
            "userId": userId,
            "sessionId": "ios-app-\(UUID().uuidString.prefix(8))"
        ]
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, response) = try await URLSession.shared.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse,
              httpResponse.statusCode == 200 else {
            throw SoulAPIError.requestFailed
        }

        let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        return json?["response"] as? String ?? "No response"
    }

    /// Create a reminder via Soul
    func createReminder(text: String, dueDate: Date? = nil) async throws -> String {
        var message = "Remind me to \(text)"
        if let due = dueDate {
            let formatter = DateFormatter()
            formatter.dateStyle = .medium
            formatter.timeStyle = .short
            message += " on \(formatter.string(from: due))"
        }
        return try await chat(message: message)
    }

    /// Create a calendar event via Soul
    func createCalendarEvent(title: String, date: Date, duration: Int = 60) async throws -> String {
        let formatter = DateFormatter()
        formatter.dateStyle = .full
        formatter.timeStyle = .short
        let message = "Schedule \(title) for \(formatter.string(from: date)) for \(duration) minutes"
        return try await chat(message: message)
    }

    /// Ask Soul a question
    func ask(question: String) async throws -> String {
        return try await chat(message: question)
    }

    /// Get today's schedule from Soul
    func getTodaySchedule() async throws -> String {
        return try await chat(message: "What's on my schedule today?")
    }

    /// Quick task capture
    func captureTask(task: String, priority: String = "normal") async throws -> String {
        return try await chat(message: "Add task: \(task) (priority: \(priority))")
    }

    /// Prepare a payment for approval (does not execute)
    /// Returns a payment ID that must be separately approved
    func preparePayment(amount: Double, recipient: String, note: String? = nil) async throws -> PreparedPayment {
        let url = URL(string: "\(baseURL)/api/payments/prepare")!
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        if let secret = portalSecret {
            request.setValue(secret, forHTTPHeaderField: "X-Portal-Secret")
        }

        var body: [String: Any] = [
            "amount": amount,
            "recipient": recipient,
            "userId": "ios-app"
        ]
        if let note = note {
            body["note"] = note
        }
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, response) = try await URLSession.shared.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse,
              httpResponse.statusCode == 200 else {
            throw SoulAPIError.requestFailed
        }

        let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        return PreparedPayment(
            id: json?["paymentId"] as? String ?? UUID().uuidString,
            amount: amount,
            recipient: recipient,
            note: note,
            status: .awaitingApproval
        )
    }

    /// Approve a prepared payment
    func approvePayment(paymentId: String) async throws -> String {
        let url = URL(string: "\(baseURL)/api/payments/approve/\(paymentId)")!
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        if let secret = portalSecret {
            request.setValue(secret, forHTTPHeaderField: "X-Portal-Secret")
        }

        let (data, response) = try await URLSession.shared.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse,
              httpResponse.statusCode == 200 else {
            throw SoulAPIError.requestFailed
        }

        let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        return json?["status"] as? String ?? "approved"
    }
}

/// Represents a payment prepared for approval
struct PreparedPayment {
    let id: String
    let amount: Double
    let recipient: String
    let note: String?
    let status: PaymentStatus
}

enum PaymentStatus {
    case awaitingApproval
    case approved
    case rejected
    case executed
}

enum SoulAPIError: Error, LocalizedError {
    case requestFailed
    case invalidResponse
    case unauthorized

    var errorDescription: String? {
        switch self {
        case .requestFailed: return "Failed to connect to Soul"
        case .invalidResponse: return "Invalid response from Soul"
        case .unauthorized: return "Not authorized to access Soul"
        }
    }
}
