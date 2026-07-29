# Model Router Plugin

This plugin automatically routes requests to the appropriate AI model based on the context and user-defined commands, improving interaction efficiency while maintaining user control.

## How It Works

1. **Session State Management:**  
   - The plugin maintains a session-specific state that holds the current model tier (heavy, standard, light).
   - Users can set this floor using specific commands, such as `>>heavy`, `>>standard`, or `>>light`, which will persist throughout the session.

2. **Explicit Overrides:**  
   - Commands like `>>off` clear any pinned model tier, returning to the default behavior for future interactions.
   - If a command is provided that matches a current model tier, the plugin will respect that and maintain the user’s preference.

3. **Contextual Awareness:**  
   - The plugin recognizes when short prompts or inquiries are made, ensuring that the user does not unintentionally switch to a lighter tier unless specified.
   - If a user prompts with a classification that falls below the current tier, the plugin will continue to apply the pinned tier.

4. **Error Notifications:**  
   - If a requested model does not exist or cannot be applied, the user will receive a notification indicating this.

## How to Use

- To set a specific model tier for your session, simply issue the command `>>heavy`, `>>standard`, or `>>light`.
- To clear a set tier, use `>>off`, which will allow the system to revert to its default model behavior.
- When sending a prompt, if it is classified as a lower tier than your current setting, the plugin will ignore this classification, maintaining the established session tier.

## Testing Instructions

To verify that the plugin works as intended:
1. Run the included unit tests to check model routing behavior.
2. Validate the session state management with various commands and prompts to ensure that expected behaviors are met.  

--- 
This plugin aims to create a user-friendly environment for interacting with AI models, ensuring consistency and control throughout the session.