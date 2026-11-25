-- A made-up copy of the app's store, small enough to read. `clockwork check` builds it in memory and runs the extractor
-- over it, so the reading code is tried with no app installed. Keep the table and column names the real store uses.
CREATE TABLE chats (id INTEGER PRIMARY KEY, title TEXT, is_group INTEGER NOT NULL DEFAULT 0);
CREATE TABLE messages (id INTEGER PRIMARY KEY, chat_id INTEGER NOT NULL, sender TEXT, sender_name TEXT, sent_at INTEGER NOT NULL, from_me INTEGER NOT NULL DEFAULT 0, body TEXT, media TEXT);
INSERT INTO chats VALUES (1, NULL, 0), (2, 'Year 4 parents', 1);
INSERT INTO messages VALUES
  (1, 1, '+15550000001', 'Dana Whitfield', 1767601800, 0, 'Are you still coming on Saturday?', NULL),
  (2, 1, NULL, NULL, 1767602100, 1, 'Yes, see you at ten.', NULL),
  (3, 2, '+15550000002', 'Priya Raman', 1767605400, 0, 'The trip money is due tomorrow morning.', NULL),
  (4, 2, '+15550000003', 'Tom Abara', 1767605460, 0, NULL, 'image');
