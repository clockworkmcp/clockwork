# Calendar

Tells Clockwork about new invitations and events in your calendars, and about changes that matter to ones you already
have: a new time, a new place, a new title, a cancellation. It works with any calendar that can give you a private
"iCal" or ".ics" address: Google Calendar, Outlook, iCloud, Fastmail and most others.

An item reads like this:

> Invitation: Budget review, Tue 17 Nov 14:00–15:00, Room 4, from Dana Example. Changed: time moved from 13:00.

## What it reads

Each calendar address you list, downloaded as a whole. From every upcoming event it takes the title, time, place,
description, who organised it, and how many people are invited and have answered. Events that are already over are
ignored. A repeating event is one item ("repeats every week"), not one per occurrence.

It can only download. An iCal address gives no way to accept, decline, add or change anything, and the program asks
the calendar's server for nothing else.

## Setting it up

1. Get the private address of each calendar:
   - **Google Calendar**: Settings > click the calendar on the left > "Integrate calendar" > **Secret address in iCal
     format**.
   - **Outlook.com / Microsoft 365**: Settings > Calendar > Shared calendars > "Publish a calendar" > choose "Can view
     all details" > copy the **ICS** link. A work account may have this switched off.
   - **iCloud**: in Calendar, share the calendar as a **Public Calendar** and copy the link (it starts with
     `webcal://`, which is fine). Note that this makes the calendar readable by anyone who has the link.
   - **Fastmail**: Settings > Calendars > the calendar's "Export" or "Share" link.
2. Put them in a file called `calendars.txt` in this extractor's data folder (`clockwork connect calendar` tells you
   the exact path if the file is missing). One address per line; you may give each a name:

   ```
   # lines starting with # are ignored
   Work = https://calendar.example.invalid/private-abc123/basic.ics
   Home = webcal://calendar.example.invalid/private-def456/home.ics
   ```

   Keep the file private (`chmod 600 calendars.txt`).
3. Run `clockwork connect calendar`, then `clockwork status`. `needs_login` means the file is missing or empty.

To add or remove a calendar later, edit the file; it is read again at every check.

## Permission needed

None on this machine. The address is the permission: **treat each address like a password.** Anyone who has it can
read that calendar. Clockwork never prints an address, in its log or anywhere else; a calendar that fails is named by
the name you gave it, or "calendar 2". If an address leaks, reset it where you got it (Google: "Reset" next to the
secret address) and put the new one in the file.

## Hosts it contacts

Only the hosts in the addresses you list (for example `calendar.google.com`, `outlook.office365.com`,
`p##-caldav.icloud.com`, or wherever those send it on to), and Clockwork on this machine (`127.0.0.1`). Each
calendar is downloaded every 15 minutes, and the server is first asked whether anything changed, so most checks
download nothing.

## What it stores, and where

In its data folder: your `calendars.txt`, and `state.json`, readable only by you. The state file holds, for each
upcoming event, its title, time and place (so that a change can be described: "time moved from 13:00"). It does not
hold the addresses. The items themselves go into Clockwork's database like every other source.

## Limits

- The first time a calendar is read, everything upcoming is brought in as history. After that only new and changed
  events are.
- Changes are noticed within about 15 minutes at best. Some providers refresh the iCal address less often than that
  (Outlook can lag by hours), and nothing here can hurry them.
- It does not know which attendee is you, so it cannot say whether you have answered, and events you organised
  yourself look like any other.
- Repeating events are not worked out occurrence by occurrence. A change to one occurrence is reported; "the next
  one is tomorrow" is not.
- An event that disappears from the calendar is reported as "Removed from the calendar". Some providers drop events
  this way instead of marking them cancelled, and some drop far-future or declined events for their own reasons.
- A change to the description or the guest list alone is not reported.
- Times are written in this machine's time zone. A time in a zone the system does not know is read as local time;
  an all-day event is the day as written.

## Risks

- The addresses are secrets kept in a plain text file on this machine. Anything that can read that file can read
  your calendars.
- Event titles, places and descriptions (which often hold meeting links and dial-in codes) are copied into
  Clockwork, in front of the local model and your agent.
- Clockwork cannot answer an invitation or change a calendar, so a mistake here cannot do either.
