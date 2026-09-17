// Invoices — `login` (01 R3): presented as a full-screen cover by RootView, so it is its own screen.

import LocalAuthentication
import SwiftUI
import UserNotifications
import AppMapKit

struct LoginView: View {
    @EnvironmentObject var router: AppRouter
    @State private var email = ""
    @State private var password = ""
    @State private var errorMessage: String?

    private let resetURL = URL(string: "https://example.com/account/reset")!

    var body: some View {
        NavigationStack {
            VStack(spacing: 16) {
                TextField("Email", text: $email)
                    .textContentType(.emailAddress)
                    .keyboardType(.emailAddress)
                    .textInputAutocapitalization(.never)
                    .textFieldStyle(.roundedBorder)
                    .appMapID(AppMapID.Element.loginEmailField)
                SecureField("Password", text: $password)
                    .textContentType(.password)
                    .textFieldStyle(.roundedBorder)
                    .appMapID(AppMapID.Element.loginPasswordField)
                if let errorMessage {
                    Text(errorMessage)
                        .font(.footnote)
                        .foregroundColor(.red)
                        .appMapID(AppMapID.Element.loginErrorText)          // data-bound text: dynamic in the registry (01 R4)
                }
                Button(action: submit) {
                    Text("Sign In")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .appMapID(AppMapID.Element.loginSubmitButton)               // not intent_critical: signing in commits nothing
                Button(action: submitWithBiometrics) {
                    Label("Use Face ID", systemImage: "faceid")
                }
                .appMapID(AppMapID.Element.loginBiometricButton)            // raises the OS Face ID sheet: a gate with no ids (01 R7)
                Link("Forgot your password?", destination: resetURL)
                    .font(.footnote)
                    .appMapID(AppMapID.Element.loginForgotLink)
            }
            .padding()
            .navigationTitle("Sign In")
        }
        .appMapScreen(AppMapID.Screen.login)                                // LAST modifier on the outermost expression (01 R3)
    }

    private func submit() {
        guard !email.isEmpty, !password.isEmpty else {
            errorMessage = "Enter your email and password."
            return
        }
        errorMessage = nil
        signedIn()
    }

    private func submitWithBiometrics() {
        let context = LAContext()
        context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: "Sign in to Invoices") { success, _ in
            guard success else { return }
            DispatchQueue.main.async { signedIn() }
        }
    }

    private func signedIn() {
        router.needsLogin = false
        // the OS notification prompt: an interrupter the map lists as a gate with a label signature, never an id (01 R7)
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound]) { _, _ in }
    }
}
