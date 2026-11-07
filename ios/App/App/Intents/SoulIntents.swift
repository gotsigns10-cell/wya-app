import AppIntents

/// Soul App Intents — Siri & Shortcuts Integration
/// (c) Universoul LLC | Santa Barbara, CA | 2026-11-03

// MARK: - Ask Soul Intent
struct AskSoulIntent: AppIntent {
    static var title: LocalizedStringResource = "Ask Soul"
    static var description = IntentDescription("Ask Soul anything")
    static var openAppWhenRun: Bool = false

    @Parameter(title: "Question")
    var question: String

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let response = try await SoulAPI.shared.ask(question: question)
        return .result(dialog: "\(response)")
    }
}

// MARK: - Create Reminder Intent
struct CreateReminderIntent: AppIntent {
    static var title: LocalizedStringResource = "Create Reminder with Soul"
    static var description = IntentDescription("Ask Soul to create a reminder")

    @Parameter(title: "Reminder Text")
    var text: String

    @Parameter(title: "Due Date")
    var dueDate: Date?

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let response = try await SoulAPI.shared.createReminder(text: text, dueDate: dueDate)
        return .result(dialog: "\(response)")
    }
}

// MARK: - Today's Schedule Intent
struct TodayScheduleIntent: AppIntent {
    static var title: LocalizedStringResource = "Today's Schedule"
    static var description = IntentDescription("Get today's schedule from Soul")
    static var openAppWhenRun: Bool = false

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let response = try await SoulAPI.shared.getTodaySchedule()
        return .result(dialog: "\(response)")
    }
}

// MARK: - Quick Task Intent
struct QuickTaskIntent: AppIntent {
    static var title: LocalizedStringResource = "Quick Task"
    static var description = IntentDescription("Capture a quick task with Soul")

    @Parameter(title: "Task")
    var task: String

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let response = try await SoulAPI.shared.captureTask(task: task)
        return .result(dialog: "\(response)")
    }
}

// MARK: - Create Calendar Event Intent
struct CreateCalendarEventIntent: AppIntent {
    static var title: LocalizedStringResource = "Create Calendar Event"
    static var description = IntentDescription("Schedule a calendar event with Soul")

    @Parameter(title: "Event Title")
    var title: String

    @Parameter(title: "Date and Time")
    var eventDate: Date

    @Parameter(title: "Duration (minutes)")
    var duration: Int?

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let response = try await SoulAPI.shared.createCalendarEvent(
            title: title,
            date: eventDate,
            duration: duration ?? 60
        )
        return .result(dialog: "\(response)")
    }
}

// MARK: - Prepare Payment Intent
/// Prepares a payment for approval — does NOT execute until separately approved
struct PreparePaymentIntent: AppIntent {
    static var title: LocalizedStringResource = "Prepare Payment"
    static var description = IntentDescription("Prepare a payment for approval (requires separate confirmation)")
    static var openAppWhenRun: Bool = true  // Opens app for approval UI

    @Parameter(title: "Amount")
    var amount: Double

    @Parameter(title: "Recipient")
    var recipient: String

    @Parameter(title: "Note")
    var note: String?

    func perform() async throws -> some IntentResult & ProvidesDialog & OpensIntent {
        let response = try await SoulAPI.shared.preparePayment(
            amount: amount,
            recipient: recipient,
            note: note
        )
        return .result(
            dialog: "Payment of $\(String(format: "%.2f", amount)) to \(recipient) prepared. Open WYA to approve.",
            opensIntent: ApprovePaymentIntent()
        )
    }
}

// MARK: - Approve Payment Intent (internal, triggered from app)
struct ApprovePaymentIntent: AppIntent {
    static var title: LocalizedStringResource = "Approve Payment"
    static var description = IntentDescription("Approve a prepared payment")
    static var openAppWhenRun: Bool = true

    @Parameter(title: "Payment ID")
    var paymentId: String?

    func perform() async throws -> some IntentResult {
        // Opens app to payment approval screen
        return .result()
    }
}

// MARK: - Check In Intent
struct CheckInIntent: AppIntent {
    static var title: LocalizedStringResource = "Check In with Soul"
    static var description = IntentDescription("Quick check-in with context")
    static var openAppWhenRun: Bool = false

    @Parameter(title: "Context")
    var context: String?

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let message = context != nil ? "Check in: \(context!)" : "Quick check in"
        let response = try await SoulAPI.shared.chat(message: message)
        return .result(dialog: "\(response)")
    }
}

// MARK: - App Shortcuts Provider
struct SoulShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: AskSoulIntent(),
            phrases: [
                "Ask \(.applicationName) a question",
                "Hey \(.applicationName)",
                "Talk to \(.applicationName)"
            ],
            shortTitle: "Ask Soul",
            systemImageName: "brain.head.profile"
        )
        AppShortcut(
            intent: CreateReminderIntent(),
            phrases: [
                "Create a reminder with \(.applicationName)",
                "Remind me with \(.applicationName)"
            ],
            shortTitle: "Create Reminder",
            systemImageName: "bell"
        )
        AppShortcut(
            intent: TodayScheduleIntent(),
            phrases: [
                "What's on my schedule \(.applicationName)",
                "Today's agenda \(.applicationName)"
            ],
            shortTitle: "Today's Schedule",
            systemImageName: "calendar"
        )
        AppShortcut(
            intent: QuickTaskIntent(),
            phrases: [
                "Add task with \(.applicationName)",
                "Quick task \(.applicationName)"
            ],
            shortTitle: "Quick Task",
            systemImageName: "checkmark.circle"
        )
        AppShortcut(
            intent: CreateCalendarEventIntent(),
            phrases: [
                "Schedule event with \(.applicationName)",
                "Create calendar event \(.applicationName)",
                "Add to calendar \(.applicationName)"
            ],
            shortTitle: "Create Event",
            systemImageName: "calendar.badge.plus"
        )
        AppShortcut(
            intent: PreparePaymentIntent(),
            phrases: [
                "Prepare payment with \(.applicationName)",
                "Send money with \(.applicationName)"
            ],
            shortTitle: "Prepare Payment",
            systemImageName: "dollarsign.circle"
        )
        AppShortcut(
            intent: CheckInIntent(),
            phrases: [
                "Check in with \(.applicationName)",
                "Quick check in \(.applicationName)"
            ],
            shortTitle: "Check In",
            systemImageName: "location.circle"
        )
    }
}
