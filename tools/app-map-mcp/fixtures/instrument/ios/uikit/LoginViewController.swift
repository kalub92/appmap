// LoginViewController — the `login` screen: marker first in viewDidLoad, ids on programmatic controls (01 R3, 01 R4).

import UIKit
import AppMapKit

final class LoginViewController: UIViewController {
    private let emailField = UITextField()
    private let passwordField = UITextField()
    private let errorLabel = UILabel()
    private let submitButton = UIButton(type: .system)
    private let forgotButton = UIButton(type: .system)

    override func viewDidLoad() {
        super.viewDidLoad()
        appMapScreen(AppMapID.Screen.login)   // 01 R3: first statement after super, exactly once per screen
        title = "Sign In"
        view.backgroundColor = .systemBackground

        emailField.placeholder = "Email"
        emailField.keyboardType = .emailAddress
        emailField.textContentType = .username
        emailField.autocapitalizationType = .none
        emailField.borderStyle = .roundedRect
        emailField.appMapID(AppMapID.Element.loginEmailField)   // 01 R4: one id per control

        passwordField.placeholder = "Password"
        passwordField.textContentType = .password
        passwordField.isSecureTextEntry = true
        passwordField.borderStyle = .roundedRect
        passwordField.appMapID(AppMapID.Element.loginPasswordField)

        errorLabel.textColor = .systemRed
        errorLabel.numberOfLines = 0
        errorLabel.isHidden = true
        errorLabel.appMapID(AppMapID.Element.loginErrorText)   // bound label: dynamic in the registry, the scrubber drops its text

        submitButton.setTitle("Sign In", for: .normal)
        submitButton.addTarget(self, action: #selector(submitTapped), for: .touchUpInside)
        submitButton.appMapID(AppMapID.Element.loginSubmitButton)

        forgotButton.setTitle("Forgot password?", for: .normal)
        forgotButton.addTarget(self, action: #selector(forgotTapped), for: .touchUpInside)
        forgotButton.appMapID(AppMapID.Element.loginForgotLink)   // kind link: it leaves the app for the reset page

        navigationItem.rightBarButtonItem = UIBarButtonItem(image: UIImage(systemName: "faceid"), style: .plain,
                                                            target: self, action: #selector(biometricTapped))
        navigationItem.rightBarButtonItem?.accessibilityIdentifier = AppMapID.Element.loginBiometricButton   // UIBarButtonItem is not a UIView: assign the constant directly (01 R8)

        let form = UIStackView(arrangedSubviews: [emailField, passwordField, errorLabel, submitButton, forgotButton])
        form.axis = .vertical
        form.spacing = 12
        form.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(form)
        NSLayoutConstraint.activate([
            form.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 32),
            form.leadingAnchor.constraint(equalTo: view.layoutMarginsGuide.leadingAnchor),
            form.trailingAnchor.constraint(equalTo: view.layoutMarginsGuide.trailingAnchor),
        ])
    }

    @objc private func submitTapped() {
        do {
            try AppRouter.shared.signIn(email: emailField.text ?? "", password: passwordField.text ?? "")
        } catch {
            errorLabel.text = error.localizedDescription
            errorLabel.isHidden = false
        }
    }

    @objc private func biometricTapped() {
        AppRouter.shared.signInWithBiometrics()   // shows the OS prompt: a gate with a label signature in the map, no id here (01 R7)
    }

    @objc private func forgotTapped() {
        guard let url = URL(string: "https://example.com/account/reset") else { return }
        UIApplication.shared.open(url)
    }
}
