// Read-only WhatsApp connector for Clockwork.
// Links as a companion device via a QR shown on a local page, then forwards history-sync and live
// messages to the Clockwork core. It never sends messages, read receipts or presence.
// Records are appended to a durable outbox first, so nothing is lost while the core is down.
package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"html"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	_ "github.com/mattn/go-sqlite3"
	qrcode "github.com/skip2/go-qrcode"
	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/store"
	"go.mau.fi/whatsmeow/store/sqlstore"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	waLog "go.mau.fi/whatsmeow/util/log"
	"google.golang.org/protobuf/reflect/protoreflect"
)

type record struct {
	SourceID   string `json:"sourceId"`
	ThreadID   string `json:"threadId"`
	Author     string `json:"author"`
	AuthorName string `json:"authorName,omitempty"`
	SourceTime string `json:"sourceTime"`
	ObservedAt string `json:"observedAt"`
	Direction  string `json:"direction"`
	IsGroup    bool   `json:"isGroup"`
	Kind       string `json:"kind"`
	Text       string `json:"text,omitempty"`
	Origin     string `json:"origin"`
	Account    string `json:"account,omitempty"` // which linked account saw it, when an instance runs more than one
	ChatName   string `json:"chatName,omitempty"` // a group's title, when known
}

type state struct {
	sync.Mutex
	Status       string          `json:"status"`
	QR           string          `json:"-"`
	QRCount      int             `json:"qrCodesIssued"`
	LinkedAt     string          `json:"linkedAt,omitempty"`
	LinkSeconds  float64         `json:"secondsFromStartToLink,omitempty"`
	HistorySyncs map[string]int  `json:"historySyncEventsByType"`
	Chats        map[string]bool `json:"-"`
	Groups       map[string]bool `json:"-"`
	NChats       int             `json:"chats"`
	NGroups      int             `json:"groupChats"`
	History      int             `json:"historyMessages"`
	Live         int             `json:"liveMessages"`
	WithText     int             `json:"messagesWithText"`
	Kinds        map[string]int  `json:"kinds"`
	Oldest       string          `json:"oldestMessage,omitempty"`
	Newest       string          `json:"newestMessage,omitempty"`
	LastEvent    string          `json:"lastEvent"`
	Forwarded    int             `json:"forwardedToCore"`
	Skipped      int             `json:"skippedRecords"`
	ForwardError string          `json:"lastForwardError,omitempty"`
	Errors       []string        `json:"errors"`
	seen         map[string]bool
	authors      map[string]bool
}

var (
	st    = &state{Status: "starting", HistorySyncs: map[string]int{}, Chats: map[string]bool{}, Groups: map[string]bool{}, Kinds: map[string]int{}, seen: map[string]bool{}, authors: map[string]bool{}}
	out   *os.File
	cli   *whatsmeow.Client
	wake  = make(chan struct{}, 1)
	start = time.Now()
	// Group titles by chat id, filled from the list of joined groups and kept current from group events.
	names   = map[string]string{}
	namesMu sync.Mutex
)

func chatName(jid string) string {
	namesMu.Lock()
	defer namesMu.Unlock()
	return names[jid]
}

func setChatName(jid, name string) {
	if name == "" {
		return
	}
	namesMu.Lock()
	names[jid] = name
	namesMu.Unlock()
}

// tellCore posts a small JSON message to the core with the connector's write-only token.
func tellCore(path string, payload any) error {
	core := os.Getenv("CLOCKWORK_CORE_URL")
	if core == "" {
		core = "http://127.0.0.1:4600"
	}
	token := os.Getenv("CLOCKWORK_INGEST_TOKEN")
	if token == "" {
		token = os.Getenv("CLOCKWORK_TOKEN")
	}
	body, _ := json.Marshal(payload)
	req, _ := http.NewRequest("POST", core+path, bytes.NewReader(body))
	req.Header.Set("content-type", "application/json")
	if token != "" {
		req.Header.Set("authorization", "Bearer "+token)
	}
	resp, err := (&http.Client{Timeout: 30 * time.Second}).Do(req)
	if err != nil {
		return err
	}
	resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("core answered %d", resp.StatusCode)
	}
	return nil
}

// syncGroups learns the titles of every group this account is in and sends them to the core, which also fills
// them in on messages it already holds.
func syncGroups(ctx context.Context) {
	groups, err := cli.GetJoinedGroups(ctx)
	if err != nil {
		note("group names: " + err.Error())
		return
	}
	chats := make([]map[string]string, 0, len(groups))
	for _, g := range groups {
		if g.Name == "" {
			continue
		}
		setChatName(g.JID.String(), g.Name)
		chats = append(chats, map[string]string{"threadId": g.JID.String(), "name": g.Name})
	}
	for i := 0; i < len(chats); i += 500 {
		end := i + 500
		if end > len(chats) {
			end = len(chats)
		}
		if err := tellCore("/ingest/chats", map[string]any{"source": "whatsapp", "chats": chats[i:end]}); err != nil {
			note("group names: " + err.Error())
			return
		}
	}
	note(fmt.Sprintf("group names: %d sent", len(chats)))
}

// heartbeat tells the core every two minutes that this connector is up and what state the link is in, so that
// "nothing new" can be told apart from "not connected". Group titles are refreshed on connect and every six hours.
func heartbeat(ctx context.Context) {
	var lastGroups time.Time
	for {
		status := "disconnected"
		st.Lock()
		if st.Status == "logged_out" || st.Status == "starting" || st.QR != "" {
			status = st.Status
			if st.QR != "" {
				status = "waiting_for_link"
			}
		}
		st.Unlock()
		if cli != nil && cli.IsConnected() && cli.IsLoggedIn() {
			status = "connected"
			if time.Since(lastGroups) > 6*time.Hour {
				lastGroups = time.Now()
				syncGroups(ctx)
			}
		}
		tellCore("/ingest/events", map[string]any{"source": "whatsapp", "events": []any{}, "account": os.Getenv("CLOCKWORK_WA_ACCOUNT"), "status": status})
		time.Sleep(2 * time.Minute)
	}
}

func kindAndText(m *waE2E.Message) (string, string) {
	if m == nil {
		return "empty", ""
	}
	switch {
	case m.GetConversation() != "":
		return "text", m.GetConversation()
	case m.GetExtendedTextMessage() != nil:
		return "text", m.GetExtendedTextMessage().GetText()
	case m.GetImageMessage() != nil:
		return "image", m.GetImageMessage().GetCaption()
	case m.GetVideoMessage() != nil:
		return "video", m.GetVideoMessage().GetCaption()
	case m.GetDocumentMessage() != nil:
		return "document", m.GetDocumentMessage().GetCaption()
	case m.GetAudioMessage() != nil:
		return "audio", ""
	case m.GetStickerMessage() != nil:
		return "sticker", ""
	case m.GetReactionMessage() != nil:
		return "reaction", m.GetReactionMessage().GetText()
	case m.GetPollCreationMessage() != nil || m.GetPollCreationMessageV3() != nil:
		return "poll", ""
	case m.GetLocationMessage() != nil || m.GetLiveLocationMessage() != nil:
		return "location", ""
	case m.GetContactMessage() != nil || m.GetContactsArrayMessage() != nil:
		return "contact", ""
	case m.GetProtocolMessage() != nil:
		return "protocol", ""
	case m.GetEphemeralMessage() != nil:
		return kindAndText(m.GetEphemeralMessage().GetMessage())
	case m.GetViewOnceMessage() != nil:
		return kindAndText(m.GetViewOnceMessage().GetMessage())
	case m.GetViewOnceMessageV2() != nil:
		return kindAndText(m.GetViewOnceMessageV2().GetMessage())
	case m.GetEditedMessage() != nil:
		return kindAndText(m.GetEditedMessage().GetMessage())
	case m.GetDocumentWithCaptionMessage() != nil:
		return kindAndText(m.GetDocumentWithCaptionMessage().GetMessage())
	case m.GetAssociatedChildMessage() != nil: // one picture or video of an album: the real message is inside
		return kindAndText(m.GetAssociatedChildMessage().GetMessage())
	}
	name := "other"
	m.ProtoReflect().Range(func(fd protoreflect.FieldDescriptor, _ protoreflect.Value) bool {
		if string(fd.Name()) != "messageContextInfo" {
			name = "other:" + string(fd.Name())
			return false
		}
		return true
	})
	return name, ""
}

func save(info types.MessageInfo, msg *waE2E.Message, origin string) {
	kind, text := kindAndText(msg)
	dir := "incoming"
	if info.IsFromMe {
		dir = "outgoing"
	}
	r := record{SourceID: info.ID, ThreadID: info.Chat.String(), Author: info.Sender.ToNonAD().String(), AuthorName: nameFor(info),
		SourceTime: info.Timestamp.UTC().Format(time.RFC3339), ObservedAt: time.Now().UTC().Format(time.RFC3339),
		Direction: dir, IsGroup: info.IsGroup, Kind: kind, Text: text, Origin: origin, Account: os.Getenv("CLOCKWORK_WA_ACCOUNT")}
	if info.IsGroup {
		r.ChatName = chatName(r.ThreadID)
	}
	st.Lock()
	defer st.Unlock()
	key := r.ThreadID + "|" + r.SourceID
	if st.seen[key] {
		return
	}
	st.seen[key] = true
	st.authors[r.Author] = true
	b, _ := json.Marshal(r)
	out.Write(append(b, '\n'))
	select {
	case wake <- struct{}{}:
	default:
	}
	st.Chats[r.ThreadID] = true
	if r.IsGroup {
		st.Groups[r.ThreadID] = true
	}
	if origin == "live" {
		st.Live++
	} else {
		st.History++
	}
	if text != "" {
		st.WithText++
	}
	st.Kinds[kind]++
	if !info.Timestamp.IsZero() {
		if st.Oldest == "" || r.SourceTime < st.Oldest {
			st.Oldest = r.SourceTime
		}
		if r.SourceTime > st.Newest {
			st.Newest = r.SourceTime
		}
	}
}

func note(s string) {
	st.Lock()
	st.LastEvent = time.Now().Format("15:04:05") + " " + s
	st.Unlock()
	fmt.Println(st.LastEvent)
}

func fail(s string) {
	st.Lock()
	st.Errors = append(st.Errors, time.Now().Format("15:04:05")+" "+s)
	if len(st.Errors) > 50 {
		st.Errors = st.Errors[len(st.Errors)-50:]
	}
	st.Unlock()
	fmt.Println("ERROR", s)
}

// nameFor returns the best display name we know for the sender: address-book name, then profile name.
func nameFor(info types.MessageInfo) string {
	if info.IsFromMe || cli == nil {
		return info.PushName
	}
	ctx := context.Background()
	jid := info.Sender.ToNonAD()
	if jid.Server == types.HiddenUserServer {
		if pn, err := cli.Store.LIDs.GetPNForLID(ctx, jid); err == nil && !pn.IsEmpty() {
			jid = pn
		}
	}
	if c, err := cli.Store.Contacts.GetContact(ctx, jid); err == nil && c.Found {
		if c.FullName != "" {
			return c.FullName
		}
		if c.PushName != "" {
			return c.PushName
		}
	}
	return info.PushName
}

// forward ships outbox lines to the core in batches and remembers how far it got.
func forward(dir string) {
	core := os.Getenv("CLOCKWORK_CORE_URL")
	if core == "" {
		core = "http://127.0.0.1:4600"
	}
	token := os.Getenv("CLOCKWORK_INGEST_TOKEN")
	if token == "" {
		token = os.Getenv("CLOCKWORK_TOKEN")
	}
	maxLines := 200 // halved when the core says a batch is too large
	offPath := filepath.Join(dir, "outbox.offset")
	var offset int64
	if b, err := os.ReadFile(offPath); err == nil {
		fmt.Sscanf(string(b), "%d", &offset)
	}
	backoff := time.Second
	for {
		f, err := os.Open(filepath.Join(dir, "messages.jsonl"))
		if err != nil {
			time.Sleep(5 * time.Second)
			continue
		}
		f.Seek(offset, 0)
		rd := bufio.NewReaderSize(f, 1<<20)
		var batch []json.RawMessage
		var read int64
		var size int
		for len(batch) < maxLines && size < 2<<20 {
			line, err := rd.ReadBytes('\n')
			if err != nil { // partial last line: leave it for the next pass
				break
			}
			read += int64(len(line))
			size += len(line)
			if t := bytes.TrimSpace(line); len(t) > 0 {
				batch = append(batch, json.RawMessage(append([]byte(nil), t...)))
			}
		}
		f.Close()
		if len(batch) == 0 {
			select {
			case <-wake:
			case <-time.After(30 * time.Second):
			}
			continue
		}
		body, _ := json.Marshal(map[string]any{"source": "whatsapp", "events": batch})
		req, _ := http.NewRequest("POST", core+"/ingest/events", bytes.NewReader(body))
		req.Header.Set("content-type", "application/json")
		if token != "" {
			req.Header.Set("authorization", "Bearer "+token)
		}
		resp, err := (&http.Client{Timeout: 30 * time.Second}).Do(req)
		if err == nil && resp.StatusCode == 200 {
			resp.Body.Close()
			offset += read
			os.WriteFile(offPath, []byte(fmt.Sprint(offset)), 0o600)
			st.Lock()
			st.Forwarded += len(batch)
			st.Unlock()
			backoff = time.Second
			if maxLines < 200 {
				maxLines *= 2
			}
			continue
		}
		if err == nil && resp.StatusCode == 413 && maxLines > 1 {
			resp.Body.Close()
			maxLines /= 2 // too large for the core: send fewer lines per request
			continue
		}
		if err == nil && (resp.StatusCode == 400 || resp.StatusCode == 413) && len(batch) == 1 {
			resp.Body.Close()
			offset += read // a single record the core will never accept: skip it rather than block everything behind it
			os.WriteFile(offPath, []byte(fmt.Sprint(offset)), 0o600)
			st.Lock()
			st.Skipped++
			st.Unlock()
			continue
		}
		if err == nil {
			resp.Body.Close()
			err = fmt.Errorf("core answered %d", resp.StatusCode)
		}
		st.Lock()
		st.ForwardError = time.Now().Format("15:04:05") + " " + err.Error()
		st.Unlock()
		time.Sleep(backoff)
		if backoff < time.Minute {
			backoff *= 2
		}
	}
}

func main() {
	home, _ := os.UserHomeDir()
	dir := os.Getenv("CLOCKWORK_WA_DATA")
	if dir == "" {
		dir = filepath.Join(home, ".clockwork", "v2", "whatsapp")
	}
	os.MkdirAll(dir, 0o700)
	var err error
	out, err = os.OpenFile(filepath.Join(dir, "messages.jsonl"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		panic(err)
	}
	if prev, err := os.ReadFile(filepath.Join(dir, "messages.jsonl")); err == nil {
		for _, line := range bytes.Split(prev, []byte("\n")) {
			var r record
			if json.Unmarshal(line, &r) == nil && r.SourceID != "" {
				st.seen[r.ThreadID+"|"+r.SourceID] = true
				st.authors[r.Author] = true
				st.Chats[r.ThreadID] = true
			}
		}
	}
	ctx := context.Background()
	store.SetOSInfo("Clockwork (read-only)", [3]uint32{0, 1, 0})
	container, err := sqlstore.New(ctx, "sqlite3", "file:"+filepath.Join(dir, "session.db")+"?_foreign_keys=on", waLog.Noop)
	if err != nil {
		panic(err)
	}
	os.Chmod(filepath.Join(dir, "session.db"), 0o600)
	device, err := container.GetFirstDevice(ctx)
	if err != nil {
		panic(err)
	}
	client := whatsmeow.NewClient(device, waLog.Stdout("wa", "WARN", false))
	cli = client
	// Unlink mode: tell WhatsApp to remove this linked device, then exit. The session is useless afterwards.
	if os.Getenv("CLOCKWORK_WA_LOGOUT") == "1" {
		if client.Store.ID == nil {
			fmt.Println("not linked: nothing to unlink")
			return
		}
		if err := client.Connect(); err != nil {
			fmt.Println("unlink failed: connect:", err)
			os.Exit(1)
		}
		if !client.WaitForConnection(30 * time.Second) {
			fmt.Println("unlink failed: no connection")
			os.Exit(1)
		}
		if err := client.Logout(ctx); err != nil {
			fmt.Println("unlink failed:", err)
			os.Exit(1)
		}
		fmt.Println("unlinked: WhatsApp removed this device")
		return
	}
	go forward(dir)
	go heartbeat(ctx)
	client.AddEventHandler(func(e interface{}) {
		switch v := e.(type) {
		case *events.JoinedGroup:
			setChatName(v.JID.String(), v.Name)
		case *events.GroupInfo:
			if v.Name != nil {
				setChatName(v.JID.String(), v.Name.Name)
			}
		case *events.PairSuccess:
			st.Lock()
			st.Status, st.QR = "linked", ""
			st.LinkedAt = time.Now().UTC().Format(time.RFC3339)
			st.LinkSeconds = time.Since(start).Seconds()
			st.Unlock()
			note("pair success")
		case *events.PairError:
			fail("pair error: " + v.Error.Error())
		case *events.Connected:
			st.Lock()
			st.Status, st.QR = "connected", ""
			st.Unlock()
			note("connected")
		case *events.Disconnected:
			note("disconnected")
		case *events.LoggedOut:
			st.Lock()
			st.Status = "logged_out"
			st.Unlock()
			fail(fmt.Sprintf("logged out: %v", v.Reason))
		case *events.ConnectFailure:
			fail(fmt.Sprintf("connect failure: %v %s", v.Reason, v.Message))
		case *events.ClientOutdated:
			fail("client outdated")
		case *events.TemporaryBan:
			fail(fmt.Sprintf("temporary ban: %v", v))
		case *events.HistorySync:
			t := v.Data.GetSyncType().String()
			n := 0
			for _, conv := range v.Data.GetConversations() {
				jid, err := types.ParseJID(conv.GetID())
				if err != nil {
					continue
				}
				for _, hm := range conv.GetMessages() {
					pm, err := client.ParseWebMessage(jid, hm.GetMessage())
					if err != nil {
						continue
					}
					save(pm.Info, pm.Message, "history:"+t)
					n++
				}
			}
			st.Lock()
			st.HistorySyncs[t]++
			st.Unlock()
			note(fmt.Sprintf("history sync %s: %d conversations, %d messages", t, len(v.Data.GetConversations()), n))
		case *events.Message:
			save(v.Info, v.Message, "live")
			note("live message")
		case *events.UndecryptableMessage:
			st.Lock()
			st.Kinds["undecryptable"]++
			st.Unlock()
		}
	})

	if client.Store.ID == nil {
		go func() {
			for client.Store.ID == nil {
				qr, err := client.GetQRChannel(ctx)
				if err != nil {
					fail("qr channel: " + err.Error())
					return
				}
				if err := client.Connect(); err != nil {
					fail("connect: " + err.Error())
					time.Sleep(5 * time.Second)
					continue
				}
				for evt := range qr {
					st.Lock()
					if evt.Event == "code" {
						st.Status, st.QR = "waiting_for_scan", evt.Code
						st.QRCount++
					} else {
						st.QR = ""
					}
					st.Unlock()
					note("qr event: " + evt.Event)
				}
				if client.Store.ID == nil {
					client.Disconnect() // codes expired: start a fresh set
					time.Sleep(time.Second)
				}
			}
		}()
	} else {
		st.Status = "reconnecting_existing_session"
		go func() {
			// Back off between attempts: hammering WhatsApp with reconnects is how accounts get flagged.
			for wait := 5 * time.Second; ; {
				err := client.Connect()
				if err == nil {
					return
				}
				fail("connect: " + err.Error())
				time.Sleep(wait)
				if wait < 10*time.Minute {
					wait *= 2
				}
			}
		}()
	}

	// The link page shows the pairing QR, so it is password-protected whenever a token is configured
	// (any username, password = CLOCKWORK_TOKEN). Without a token it must only listen on loopback.
	pageToken := os.Getenv("CLOCKWORK_TOKEN")
	mux := http.NewServeMux()
	guard := func(h http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			if pageToken != "" {
				_, pass, ok := r.BasicAuth()
				if !ok || subtle.ConstantTimeCompare([]byte(pass), []byte(pageToken)) != 1 {
					w.Header().Set("WWW-Authenticate", `Basic realm="Clockwork"`)
					http.Error(w, "unauthorized", http.StatusUnauthorized)
					return
				}
			}
			h(w, r)
		}
	}
	mux.HandleFunc("/stats", guard(func(w http.ResponseWriter, r *http.Request) {
		st.Lock()
		st.NChats, st.NGroups = len(st.Chats), len(st.Groups)
		b, _ := json.MarshalIndent(st, "", "  ")
		st.Unlock()
		w.Header().Set("Content-Type", "application/json")
		w.Write(b)
	}))
	mux.HandleFunc("/names", guard(func(w http.ResponseWriter, r *http.Request) {
		st.Lock()
		authors := map[string]bool{}
		for k := range st.authors {
			authors[k] = true
		}
		st.Unlock()
		res := map[string]int{}
		for a := range authors {
			jid, err := types.ParseJID(a)
			if err != nil {
				res["unparseable"]++
				continue
			}
			res["authors_"+jid.Server]++
			if jid.Server == types.HiddenUserServer {
				if pn, err := client.Store.LIDs.GetPNForLID(ctx, jid); err == nil && !pn.IsEmpty() {
					res["lid_mapped_to_phone"]++
					jid = pn
				}
			}
			if c, err := client.Store.Contacts.GetContact(ctx, jid); err == nil && c.Found {
				if c.FullName != "" {
					res["has_contact_name"]++
				} else if c.PushName != "" {
					res["has_push_name_only"]++
				}
			}
		}
		b, _ := json.Marshal(res)
		w.Write(b)
	}))
	mux.HandleFunc("/", guard(func(w http.ResponseWriter, r *http.Request) {
		st.Lock()
		status, code, last := st.Status, st.QR, st.LastEvent
		hist, live, chats := st.History, st.Live, len(st.Chats)
		st.Unlock()
		img := ""
		if code != "" {
			png, _ := qrcode.Encode(code, qrcode.Medium, 360)
			img = `<img alt="WhatsApp link QR code" width="360" height="360" src="data:image/png;base64,` + base64.StdEncoding.EncodeToString(png) + `">` +
				`<p>On your phone: WhatsApp &rarr; Settings &rarr; Linked devices &rarr; Link a device, then scan this code. It refreshes by itself.</p>`
		}
		fmt.Fprintf(w, `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="3"><title>Clockwork WhatsApp link</title>
<body style="font:16px system-ui;max-width:520px;margin:40px auto;padding:0 16px;background:#fff;color:#111">
<h1 style="font-size:20px">Clockwork WhatsApp link (read-only)</h1>
<p>Status: <b>%s</b></p>%s
<p>History messages: %d &middot; live messages: %d &middot; chats: %d</p>
<p style="color:#666">%s</p></body>`, html.EscapeString(status), img, hist, live, chats, html.EscapeString(last))
	}))
	listen := os.Getenv("CLOCKWORK_WA_LISTEN")
	if listen == "" {
		listen = "127.0.0.1:4599"
	}
	if pageToken == "" && !strings.HasPrefix(listen, "127.0.0.1:") && !strings.HasPrefix(listen, "localhost:") {
		fmt.Println("refusing to serve the link page on", listen, "without CLOCKWORK_TOKEN")
		os.Exit(1)
	}
	go func() {
		if err := http.ListenAndServe(listen, mux); err != nil {
			fail(err.Error())
		}
	}()
	fmt.Println("link page on http://" + listen)
	c := make(chan os.Signal, 1)
	signal.Notify(c, os.Interrupt, syscall.SIGTERM)
	<-c
	client.Disconnect()
	out.Close()
}
