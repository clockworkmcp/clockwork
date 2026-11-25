# Risks to your accounts

Clockwork is not affiliated with, endorsed by or connected to WhatsApp, Meta, Google, Slack, Salesforce or X Corp.
Their names are used only to say which of your own accounts an extractor reads.

- **WhatsApp** is read as a linked device through the open-source [whatsmeow](https://github.com/tulir/whatsmeow)
  library, which is not an official WhatsApp client. WhatsApp's terms do not allow unofficial clients, and it can
  restrict or ban an account that uses one. Consider trying a secondary number first.
- **X** is read by a separate Chrome window on your machine that you log in to yourself. X's terms do not allow
  automated reading without its consent, and it can restrict or suspend an account. It is off until you connect it.
  Clockwork never answers a login check for you.
- **Gmail** is read through Google's own API with an OAuth client that you create, with read-only access.
- **Gmail with an app password** (`gmail-imap`) is read over IMAP. A Google app password is not read-only and not
  limited to mail: whoever holds it can read, send and delete your mail without your second step, and it sits
  unencrypted in a file on your disk. The program opens the mailbox read-only and cannot send a command that changes
  it, but Google does not enforce that. Prefer the API extractor if you can spare the setup.
- **Slack** is read through Slack's own API with an app that you create, with reading permissions only. A work Slack
  usually needs an admin to approve the app, and whether you may copy work messages to your machine and your agent is
  your employer's decision, not Clockwork's.
- **Outlook, Jira, Linear, GitHub, GitLab** and other work accounts: the same applies. Each is read through the
  service's own API with a read-only key you create, and whether work items may be copied to your machine and shown
  to your agent is your employer's decision.
- **iMessage** needs Full Disk Access for the program that runs Clockwork, which is a broad permission, and it copies
  your texts, including verification codes, into Clockwork.
- **Discord** is read only through a bot you add to servers. Reading with your own account's token breaks Discord's
  rules and is not supported.
