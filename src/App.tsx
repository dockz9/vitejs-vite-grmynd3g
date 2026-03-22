// @ts-nocheck
import { useState, useEffect, useRef } from "react";
import { initializeApp } from "firebase/app";
import {
  getFirestore, collection, onSnapshot,
  addDoc, updateDoc, deleteDoc, doc, setDoc, getDoc
} from "firebase/firestore";
import { getStorage, ref, uploadBytes, getDownloadURL } from "firebase/storage";

// ─── PASTE YOUR FIREBASE CONFIG HERE ─────────────────────────────────────────
const firebaseConfig = {
  apiKey: "AIzaSyBs2rE2LhIQ6-8iHcjqNm1JoMpLnrEppes",
  authDomain: "crmz-503e0.firebaseapp.com",
  projectId: "crmz-503e0",
  storageBucket: "crmz-503e0.firebasestorage.app",
  messagingSenderId: "631776362334",
  appId: "1:631776362334:web:b886d3684885884d0259cf",
};
// ─────────────────────────────────────────────────────────────────────────────

// ─── PASTE YOUR GOOGLE OAUTH CLIENT ID HERE ───────────────────────────────────
const GMAIL_CLIENT_ID = "597640152215-h9luh049s6ghd0ajhsljh2sioqo2dsbd.apps.googleusercontent.com";
// ─────────────────────────────────────────────────────────────────────────────

// ─── PASTE YOUR NEWS API KEY HERE (free at newsapi.org) ──────────────────────
const NEWS_API_KEY = "PASTE_YOUR_NEWS_API_KEY";
// ─────────────────────────────────────────────────────────────────────────────

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const storage = getStorage(app);

const TABS = ["Contacts", "Groups", "Emails", "Meetings", "Pitchdecks", "News", "Outreach"];
const STATUS_COLORS = {
  prospect: "#f59e0b", active: "#10b981", inactive: "#6b7280", customer: "#3b82f6",
};

// ─── FIRESTORE HOOK ───────────────────────────────────────────────────────────
function useCollection(name) {
  const [docs, setDocs] = useState([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const unsub = onSnapshot(collection(db, name), snap => {
      setDocs(snap.docs.map(d => ({ id: d.id, ...d.data() })));
      setLoading(false);
    });
    return unsub;
  }, [name]);
  async function add(data) { return await addDoc(collection(db, name), data); }
  async function update(id, data) { await updateDoc(doc(db, name, id), data); }
  async function remove(id) { await deleteDoc(doc(db, name, id)); }
  return { docs, loading, add, update, remove };
}

// ─── GMAIL SYNC HOOK ──────────────────────────────────────────────────────────
function useGmailSync(contacts, emailsCol, gmailAccounts) {
  const [syncing, setSyncing] = useState(false);
  const [lastSync, setLastSync] = useState(null);

  async function connectGmail() {
    const params = new URLSearchParams({
      client_id: GMAIL_CLIENT_ID,
      redirect_uri: window.location.origin,
      response_type: "token",
      scope: "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/userinfo.email",
      prompt: "consent",
    });
    const popup = window.open(`https://accounts.google.com/o/oauth2/v2/auth?${params}`, "gmailAuth", "width=500,height=600,left=200,top=100");
    const interval = setInterval(async () => {
      try {
        if (popup.closed) { clearInterval(interval); return; }
        const hash = popup.location.hash;
        if (hash && hash.includes("access_token")) {
          clearInterval(interval);
          popup.close();
          const tokenParams = new URLSearchParams(hash.slice(1));
          const token = tokenParams.get("access_token");
          // Get email address
          const profileRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", { headers: { Authorization: `Bearer ${token}` } });
          const profile = await profileRes.json();
          await addDoc(collection(db, "gmail_accounts"), { email: profile.email, access_token: token, connected_at: new Date().toISOString() });
        }
      } catch (e) {}
    }, 500);
  }

  async function syncAll() {
    if (!gmailAccounts.length || !contacts.length) return;
    setSyncing(true);
    const contactEmails = contacts.map(c => c.email?.toLowerCase()).filter(Boolean);
    const query = contactEmails.map(e => `from:${e} OR to:${e}`).join(" OR ");
    const syncedIds = new Set(emailsCol.docs.filter(e => e.gmailId).map(e => e.gmailId));

    for (const account of gmailAccounts) {
      try {
        const [inboxRes, sentRes] = await Promise.all([
          fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=30`, { headers: { Authorization: `Bearer ${account.access_token}` } }),
          fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(`in:sent ${query}`)}&maxResults=30`, { headers: { Authorization: `Bearer ${account.access_token}` } }),
        ]);
        if (inboxRes.status === 401) continue;
        const inbox = await inboxRes.json();
        const sent = await sentRes.json();
        const allIds = [...(inbox.messages || []), ...(sent.messages || [])];
        for (const msg of allIds) {
          if (syncedIds.has(msg.id)) continue;
          const detailRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`, { headers: { Authorization: `Bearer ${account.access_token}` } });
          const detail = await detailRes.json();
          const headers = detail.payload?.headers || [];
          const from = headers.find(h => h.name === "From")?.value || "";
          const to = headers.find(h => h.name === "To")?.value || "";
          const subject = headers.find(h => h.name === "Subject")?.value || "(no subject)";
          const date = headers.find(h => h.name === "Date")?.value || "";
          const fromEmail = from.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/)?.[0]?.toLowerCase();
          const toEmail = to.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/)?.[0]?.toLowerCase();
          const contact = contacts.find(c => c.email?.toLowerCase() === fromEmail || c.email?.toLowerCase() === toEmail);
          if (!contact) continue;
          const direction = contactEmails.includes(fromEmail) ? "received" : "sent";
          await emailsCol.add({ gmailId: msg.id, contactId: contact.id, subject, body: "", date: date ? new Date(date).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10), direction, status: "read", autoSynced: true, gmailAccount: account.email });
          syncedIds.add(msg.id);
        }
      } catch (e) { console.error("Sync error for", account.email, e); }
    }
    setLastSync(new Date());
    setSyncing(false);
  }

  useEffect(() => {
    if (!gmailAccounts.length || !contacts.length) return;
    syncAll();
    const interval = setInterval(syncAll, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [gmailAccounts.length, contacts.length]);

  return { syncing, lastSync, connectGmail, syncAll };
}

// ─── GOOGLE CALENDAR HOOK ─────────────────────────────────────────────────────
function useGoogleCalendar(contacts, meetingsCol) {
  const [calToken, setCalToken] = useState(null);
  const [calConnected, setCalConnected] = useState(false);
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    async function load() {
      try {
        const snap = await getDoc(doc(db, "settings", "calendar"));
        if (snap.exists() && snap.data().access_token) { setCalToken(snap.data().access_token); setCalConnected(true); }
      } catch (e) {}
    }
    load();
  }, []);

  function connectCalendar() {
    const params = new URLSearchParams({
      client_id: GMAIL_CLIENT_ID,
      redirect_uri: window.location.origin,
      response_type: "token",
      scope: "https://www.googleapis.com/auth/calendar.readonly",
      prompt: "consent",
    });
    const popup = window.open(`https://accounts.google.com/o/oauth2/v2/auth?${params}`, "calAuth", "width=500,height=600,left=200,top=100");
    const interval = setInterval(async () => {
      try {
        if (popup.closed) { clearInterval(interval); return; }
        const hash = popup.location.hash;
        if (hash && hash.includes("access_token")) {
          clearInterval(interval);
          popup.close();
          const token = new URLSearchParams(hash.slice(1)).get("access_token");
          setCalToken(token); setCalConnected(true);
          await setDoc(doc(db, "settings", "calendar"), { access_token: token, connected_at: new Date().toISOString() });
          await syncCalendar(token);
        }
      } catch (e) {}
    }, 500);
  }

  async function syncCalendar(token) {
    const t = token || calToken;
    if (!t) return;
    setSyncing(true);
    try {
      const now = new Date();
      const twoWeeksAgo = new Date(now - 14 * 24 * 60 * 60 * 1000).toISOString();
      const twoWeeksAhead = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000).toISOString();
      const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${twoWeeksAgo}&timeMax=${twoWeeksAhead}&maxResults=50&singleEvents=true&orderBy=startTime`, { headers: { Authorization: `Bearer ${t}` } });
      if (res.status === 401) { setCalConnected(false); setSyncing(false); return; }
      const data = await res.json();
      const syncedIds = new Set(meetingsCol.docs.filter(m => m.calEventId).map(m => m.calEventId));
      for (const event of (data.items || [])) {
        if (syncedIds.has(event.id) || !event.summary) continue;
        const attendeeEmails = (event.attendees || []).map(a => a.email?.toLowerCase());
        const contact = contacts.find(c => attendeeEmails.includes(c.email?.toLowerCase()));
        const startDate = event.start?.dateTime || event.start?.date || "";
        const date = startDate.slice(0, 10);
        const time = startDate.includes("T") ? new Date(startDate).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "All day";
        const endDate = event.end?.dateTime || event.end?.date || "";
        const duration = startDate && endDate && startDate.includes("T") ? Math.round((new Date(endDate) - new Date(startDate)) / 60000) : 60;
        await meetingsCol.add({ calEventId: event.id, contactId: contact?.id || null, title: event.summary, date, time, duration, notes: event.description || "", status: new Date(startDate) < now ? "completed" : "upcoming", autoSynced: true });
        syncedIds.add(event.id);
      }
    } catch (e) { console.error("Calendar sync error", e); }
    setSyncing(false);
  }

  return { calConnected, syncing, connectCalendar, syncCalendar: () => syncCalendar() };
}

// ─── UI COMPONENTS ────────────────────────────────────────────────────────────
function Avatar({ name, size = 36 }) {
  const initials = (name || "?").split(" ").map(n => n[0]).join("").slice(0, 2).toUpperCase();
  const colors = ["#6366f1","#ec4899","#f59e0b","#10b981","#3b82f6","#8b5cf6","#ef4444"];
  const color = colors[(name || "?").charCodeAt(0) % colors.length];
  return <div style={{ width: size, height: size, borderRadius: "50%", background: color, display: "flex", alignItems: "center", justifyContent: "center", fontSize: size * 0.35, fontWeight: 700, color: "#fff", flexShrink: 0 }}>{initials}</div>;
}

function StatusBadge({ status }) {
  return <span style={{ background: STATUS_COLORS[status] + "22", color: STATUS_COLORS[status], border: `1px solid ${STATUS_COLORS[status]}44`, borderRadius: 20, padding: "2px 10px", fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em" }}>{status}</span>;
}

function Modal({ title, onClose, children, wide }) {
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <div style={{ background: "#13131a", border: "1px solid #2a2a3a", borderRadius: 16, width: "100%", maxWidth: wide ? 800 : 560, maxHeight: "90vh", overflowY: "auto", padding: 32 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: "#f0f0ff", fontFamily: "'Syne', sans-serif" }}>{title}</h2>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "#666", cursor: "pointer", fontSize: 22 }}>×</button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Field({ label, value, onChange, type = "text", placeholder = "", as = "input", required }) {
  const s = { width: "100%", background: "#0d0d14", border: "1px solid #2a2a3a", borderRadius: 8, padding: "10px 14px", color: "#e0e0ff", fontSize: 14, fontFamily: "inherit", outline: "none", boxSizing: "border-box", resize: as === "textarea" ? "vertical" : undefined, minHeight: as === "textarea" ? 90 : undefined };
  return (
    <div style={{ marginBottom: 16 }}>
      {label && <label style={{ display: "block", marginBottom: 6, fontSize: 12, fontWeight: 600, color: "#888", textTransform: "uppercase", letterSpacing: "0.06em" }}>{label}{required && " *"}</label>}
      {as === "textarea" ? <textarea style={s} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} /> : <input style={s} type={type} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} />}
    </div>
  );
}

function Sel({ label, value, onChange, options }) {
  return (
    <div style={{ marginBottom: 16 }}>
      {label && <label style={{ display: "block", marginBottom: 6, fontSize: 12, fontWeight: 600, color: "#888", textTransform: "uppercase", letterSpacing: "0.06em" }}>{label}</label>}
      <select value={value} onChange={e => onChange(e.target.value)} style={{ width: "100%", background: "#0d0d14", border: "1px solid #2a2a3a", borderRadius: 8, padding: "10px 14px", color: "#e0e0ff", fontSize: 14, fontFamily: "inherit", outline: "none" }}>
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );
}

function Btn({ children, onClick, variant = "primary", size = "md", disabled }) {
  const base = { border: "none", borderRadius: 8, fontWeight: 600, cursor: disabled ? "not-allowed" : "pointer", fontFamily: "'Syne', sans-serif", transition: "all 0.15s", opacity: disabled ? 0.5 : 1 };
  const v = {
    primary: { background: "#6366f1", color: "#fff", padding: size === "sm" ? "7px 14px" : "10px 22px", fontSize: size === "sm" ? 13 : 14 },
    ghost: { background: "transparent", color: "#9999cc", border: "1px solid #2a2a3a", padding: size === "sm" ? "7px 14px" : "10px 22px", fontSize: size === "sm" ? 13 : 14 },
    danger: { background: "#ef4444", color: "#fff", padding: size === "sm" ? "7px 14px" : "10px 22px", fontSize: size === "sm" ? 13 : 14 },
    green: { background: "#10b981", color: "#fff", padding: size === "sm" ? "7px 14px" : "10px 22px", fontSize: size === "sm" ? 13 : 14 },
    yellow: { background: "#f59e0b", color: "#fff", padding: size === "sm" ? "7px 14px" : "10px 22px", fontSize: size === "sm" ? 13 : 14 },
  };
  return <button onClick={onClick} disabled={disabled} style={{ ...base, ...v[variant] }}>{children}</button>;
}

function Spinner() {
  return <div style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: "80px 0", color: "#555", fontSize: 13 }}>⟳ Loading…</div>;
}

function Tag({ children, color = "#6366f1" }) {
  return <span style={{ background: color + "15", color, border: `1px solid ${color}30`, borderRadius: 20, padding: "1px 9px", fontSize: 11, fontWeight: 600 }}>{children}</span>;
}

// ─── CSV IMPORT ───────────────────────────────────────────────────────────────
function CSVImportModal({ onClose, contactsCol }) {
  const [preview, setPreview] = useState([]);
  const [mapping, setMapping] = useState({});
  const [importing, setImporting] = useState(false);
  const [done, setDone] = useState(false);
  const fileRef = useRef();

  function parseCSV(text) {
    const lines = text.trim().split("\n");
    const headers = lines[0].split(",").map(h => h.trim().replace(/"/g, ""));
    const rows = lines.slice(1).map(line => {
      const vals = line.split(",").map(v => v.trim().replace(/"/g, ""));
      return headers.reduce((obj, h, i) => ({ ...obj, [h]: vals[i] || "" }), {});
    });
    return { headers, rows };
  }

  function handleFile(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      const { headers, rows } = parseCSV(ev.target.result);
      setPreview({ headers, rows: rows.slice(0, 3), allRows: rows });
      // Auto-map common field names
      const autoMap = {};
      headers.forEach(h => {
        const lower = h.toLowerCase();
        if (lower.includes("name") && !lower.includes("company")) autoMap.name = h;
        if (lower.includes("email")) autoMap.email = h;
        if (lower.includes("company") || lower.includes("org")) autoMap.company = h;
        if (lower.includes("phone") || lower.includes("mobile")) autoMap.phone = h;
        if (lower.includes("note")) autoMap.notes = h;
        if (lower.includes("status")) autoMap.status = h;
      });
      setMapping(autoMap);
    };
    reader.readAsText(file);
  }

  async function doImport() {
    setImporting(true);
    const rows = preview.allRows;
    for (const row of rows) {
      const contact = {
        name: row[mapping.name] || "",
        email: row[mapping.email] || "",
        company: row[mapping.company] || "",
        phone: row[mapping.phone] || "",
        notes: row[mapping.notes] || "",
        status: row[mapping.status] || "prospect",
        tags: [],
        importedAt: new Date().toISOString(),
      };
      if (contact.name || contact.email) await contactsCol.add(contact);
    }
    setImporting(false);
    setDone(true);
  }

  return (
    <Modal title="Import Contacts from CSV" onClose={onClose} wide>
      {!preview.headers ? (
        <div>
          <p style={{ color: "#888", fontSize: 13, marginBottom: 20, lineHeight: 1.6 }}>Export your contacts from your old CRM as a CSV file, then upload it here. Works with HubSpot, Salesforce, Excel, Google Contacts, and most CRMs.</p>
          <div style={{ border: "2px dashed #2a2a3a", borderRadius: 12, padding: "40px", textAlign: "center", cursor: "pointer" }} onClick={() => fileRef.current.click()}>
            <div style={{ fontSize: 32, marginBottom: 8 }}>📁</div>
            <div style={{ color: "#888", fontSize: 13 }}>Click to upload CSV file</div>
            <input ref={fileRef} type="file" accept=".csv" style={{ display: "none" }} onChange={handleFile} />
          </div>
        </div>
      ) : done ? (
        <div style={{ textAlign: "center", padding: "40px 0" }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>🎉</div>
          <div style={{ fontSize: 18, fontWeight: 700, color: "#f0f0ff", marginBottom: 8 }}>Import Complete!</div>
          <div style={{ color: "#888", fontSize: 13, marginBottom: 24 }}>{preview.allRows.length} contacts imported successfully.</div>
          <Btn onClick={onClose}>Close</Btn>
        </div>
      ) : (
        <div>
          <p style={{ color: "#888", fontSize: 13, marginBottom: 16 }}>Found {preview.allRows.length} contacts. Map your CSV columns to CRM fields:</p>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 20 }}>
            {["name", "email", "company", "phone", "notes", "status"].map(field => (
              <div key={field}>
                <label style={{ display: "block", marginBottom: 4, fontSize: 11, fontWeight: 700, color: "#888", textTransform: "uppercase", letterSpacing: "0.06em" }}>{field}</label>
                <select value={mapping[field] || ""} onChange={e => setMapping(m => ({ ...m, [field]: e.target.value }))} style={{ width: "100%", background: "#0d0d14", border: "1px solid #2a2a3a", borderRadius: 8, padding: "8px 12px", color: "#e0e0ff", fontSize: 13, fontFamily: "inherit", outline: "none" }}>
                  <option value="">-- skip --</option>
                  {preview.headers.map(h => <option key={h} value={h}>{h}</option>)}
                </select>
              </div>
            ))}
          </div>
          <div style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#888", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>Preview (first 3 rows)</div>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead>
                  <tr>{preview.headers.map(h => <th key={h} style={{ padding: "6px 10px", textAlign: "left", color: "#666", borderBottom: "1px solid #2a2a3a" }}>{h}</th>)}</tr>
                </thead>
                <tbody>
                  {preview.rows.map((row, i) => <tr key={i}>{preview.headers.map(h => <td key={h} style={{ padding: "6px 10px", color: "#ccc", borderBottom: "1px solid #1a1a2a" }}>{row[h]}</td>)}</tr>)}
                </tbody>
              </table>
            </div>
          </div>
          <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
            <Btn variant="ghost" onClick={onClose}>Cancel</Btn>
            <Btn onClick={doImport} disabled={importing || !mapping.name}>{importing ? "Importing…" : `Import ${preview.allRows.length} Contacts`}</Btn>
          </div>
        </div>
      )}
    </Modal>
  );
}

// ─── CONTACTS TAB ─────────────────────────────────────────────────────────────
function ContactsTab({ contacts, emails, meetings, groups, contactsCol }) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [groupFilter, setGroupFilter] = useState("all");
  const [showModal, setShowModal] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [editing, setEditing] = useState(null);
  const blank = { name: "", company: "", email: "", phone: "", status: "prospect", tags: "", notes: "" };
  const [form, setForm] = useState(blank);

  const filtered = contacts.filter(c => {
    const q = search.toLowerCase();
    const matchSearch = c.name?.toLowerCase().includes(q) || c.company?.toLowerCase().includes(q) || c.email?.toLowerCase().includes(q);
    const matchFilter = filter === "all" || c.status === filter;
    const matchGroup = groupFilter === "all" || (c.groups || []).includes(groupFilter);
    return matchSearch && matchFilter && matchGroup;
  });

  function openNew() { setForm(blank); setEditing(null); setShowModal(true); }
  function openEdit(c) { setForm({ ...c, tags: (c.tags || []).join(", ") }); setEditing(c); setShowModal(true); }

  async function save() {
    const data = { ...form, tags: form.tags.split(",").map(t => t.trim()).filter(Boolean) };
    if (editing) await contactsCol.update(editing.id, data);
    else await contactsCol.add(data);
    setShowModal(false);
  }

  return (
    <div>
      <div style={{ display: "flex", gap: 12, marginBottom: 20, flexWrap: "wrap" }}>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search contacts…" style={{ flex: 1, minWidth: 180, background: "#0d0d14", border: "1px solid #2a2a3a", borderRadius: 8, padding: "10px 14px", color: "#e0e0ff", fontSize: 14, fontFamily: "inherit", outline: "none" }} />
        <select value={filter} onChange={e => setFilter(e.target.value)} style={{ background: "#0d0d14", border: "1px solid #2a2a3a", borderRadius: 8, padding: "10px 14px", color: "#e0e0ff", fontSize: 14, fontFamily: "inherit", outline: "none" }}>
          {["all","prospect","active","customer","inactive"].map(s => <option key={s} value={s}>{s === "all" ? "All Statuses" : s.charAt(0).toUpperCase() + s.slice(1)}</option>)}
        </select>
        <select value={groupFilter} onChange={e => setGroupFilter(e.target.value)} style={{ background: "#0d0d14", border: "1px solid #2a2a3a", borderRadius: 8, padding: "10px 14px", color: "#e0e0ff", fontSize: 14, fontFamily: "inherit", outline: "none" }}>
          <option value="all">All Groups</option>
          {groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
        </select>
        <Btn variant="ghost" onClick={() => setShowImport(true)}>⬆ Import CSV</Btn>
        <Btn onClick={openNew}>+ New Contact</Btn>
      </div>
      <div style={{ color: "#555", fontSize: 12, marginBottom: 12 }}>{filtered.length} contacts</div>
      <div style={{ display: "grid", gap: 12 }}>
        {filtered.map(c => {
          const cEmails = emails.filter(e => e.contactId === c.id).length;
          const cMeetings = meetings.filter(m => m.contactId === c.id).length;
          const cGroups = groups.filter(g => (c.groups || []).includes(g.id));
          return (
            <div key={c.id} style={{ background: "#0d0d14", border: "1px solid #1e1e2e", borderRadius: 12, padding: 20, display: "flex", alignItems: "center", gap: 16, transition: "border-color 0.15s" }}
              onMouseEnter={e => e.currentTarget.style.borderColor = "#6366f1"}
              onMouseLeave={e => e.currentTarget.style.borderColor = "#1e1e2e"}>
              <Avatar name={c.name || "?"} size={44} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4, flexWrap: "wrap" }}>
                  <span style={{ fontWeight: 700, fontSize: 15, color: "#f0f0ff", fontFamily: "'Syne', sans-serif" }}>{c.name}</span>
                  <StatusBadge status={c.status} />
                  {cGroups.map(g => <Tag key={g.id} color={g.color || "#6366f1"}>{g.name}</Tag>)}
                </div>
                <div style={{ fontSize: 13, color: "#888", marginBottom: 6 }}>{c.company} · {c.email}</div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {(c.tags || []).map(t => <Tag key={t}>{t}</Tag>)}
                </div>
              </div>
              <div style={{ display: "flex", gap: 20, color: "#666", fontSize: 12, textAlign: "center" }}>
                <div><div style={{ fontSize: 18, fontWeight: 700, color: "#9999cc" }}>{cEmails}</div>emails</div>
                <div><div style={{ fontSize: 18, fontWeight: 700, color: "#9999cc" }}>{cMeetings}</div>meetings</div>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <Btn size="sm" variant="ghost" onClick={() => openEdit(c)}>Edit</Btn>
                <Btn size="sm" variant="danger" onClick={() => contactsCol.remove(c.id)}>×</Btn>
              </div>
            </div>
          );
        })}
        {filtered.length === 0 && <div style={{ textAlign: "center", color: "#555", padding: "60px 0", fontStyle: "italic" }}>No contacts found.</div>}
      </div>
      {showImport && <CSVImportModal onClose={() => setShowImport(false)} contactsCol={contactsCol} />}
      {showModal && (
        <Modal title={editing ? "Edit Contact" : "New Contact"} onClose={() => setShowModal(false)}>
          <Field label="Full Name" value={form.name} onChange={v => setForm(f => ({ ...f, name: v }))} required />
          <Field label="Company" value={form.company} onChange={v => setForm(f => ({ ...f, company: v }))} />
          <Field label="Email" value={form.email} onChange={v => setForm(f => ({ ...f, email: v }))} type="email" />
          <Field label="Phone" value={form.phone} onChange={v => setForm(f => ({ ...f, phone: v }))} />
          <Sel label="Status" value={form.status} onChange={v => setForm(f => ({ ...f, status: v }))} options={["prospect","active","customer","inactive"].map(s => ({ value: s, label: s.charAt(0).toUpperCase() + s.slice(1) }))} />
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: "block", marginBottom: 6, fontSize: 12, fontWeight: 600, color: "#888", textTransform: "uppercase", letterSpacing: "0.06em" }}>Groups</label>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {groups.map(g => {
                const inGroup = (form.groups || []).includes(g.id);
                return <button key={g.id} onClick={() => setForm(f => ({ ...f, groups: inGroup ? (f.groups || []).filter(x => x !== g.id) : [...(f.groups || []), g.id] }))} style={{ padding: "4px 12px", borderRadius: 20, border: `1px solid ${g.color || "#6366f1"}`, background: inGroup ? (g.color || "#6366f1") : "transparent", color: inGroup ? "#fff" : (g.color || "#6366f1"), cursor: "pointer", fontSize: 12, fontWeight: 600 }}>{g.name}</button>;
              })}
              {groups.length === 0 && <span style={{ color: "#555", fontSize: 12 }}>No groups yet — create them in the Groups tab</span>}
            </div>
          </div>
          <Field label="Tags (comma-separated)" value={form.tags} onChange={v => setForm(f => ({ ...f, tags: v }))} placeholder="e.g. enterprise, warm lead" />
          <Field label="Notes" value={form.notes} onChange={v => setForm(f => ({ ...f, notes: v }))} as="textarea" />
          <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
            <Btn variant="ghost" onClick={() => setShowModal(false)}>Cancel</Btn>
            <Btn onClick={save} disabled={!form.name && !form.email}>Save Contact</Btn>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ─── GROUPS TAB ───────────────────────────────────────────────────────────────
function GroupsTab({ groups, groupsCol, contacts, contactsCol }) {
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({ name: "", description: "", color: "#6366f1" });
  const [selected, setSelected] = useState(null);

  const COLORS = ["#6366f1","#ec4899","#f59e0b","#10b981","#3b82f6","#8b5cf6","#ef4444","#06b6d4"];

  function openNew() { setForm({ name: "", description: "", color: "#6366f1" }); setEditing(null); setShowModal(true); }
  function openEdit(g) { setForm(g); setEditing(g); setShowModal(true); }

  async function save() {
    if (editing) await groupsCol.update(editing.id, form);
    else await groupsCol.add(form);
    setShowModal(false);
  }

  const selectedGroup = groups.find(g => g.id === selected);
  const groupContacts = selected ? contacts.filter(c => (c.groups || []).includes(selected)) : [];

  async function removeFromGroup(contactId) {
    const contact = contacts.find(c => c.id === contactId);
    if (!contact) return;
    await contactsCol.update(contactId, { groups: (contact.groups || []).filter(g => g !== selected) });
  }

  return (
    <div style={{ display: "grid", gridTemplateColumns: selected ? "300px 1fr" : "1fr", gap: 20 }}>
      <div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <h3 style={{ color: "#9999cc", fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em" }}>All Groups</h3>
          <Btn size="sm" onClick={openNew}>+ New Group</Btn>
        </div>
        <div style={{ display: "grid", gap: 10 }}>
          {groups.map(g => {
            const count = contacts.filter(c => (c.groups || []).includes(g.id)).length;
            return (
              <div key={g.id} onClick={() => setSelected(selected === g.id ? null : g.id)} style={{ background: "#0d0d14", border: `1px solid ${selected === g.id ? g.color || "#6366f1" : "#1e1e2e"}`, borderRadius: 12, padding: "14px 18px", cursor: "pointer", transition: "all 0.15s" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div style={{ width: 12, height: 12, borderRadius: "50%", background: g.color || "#6366f1", flexShrink: 0 }} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 700, color: "#f0f0ff", fontSize: 14 }}>{g.name}</div>
                    {g.description && <div style={{ fontSize: 12, color: "#666", marginTop: 2 }}>{g.description}</div>}
                  </div>
                  <div style={{ fontSize: 20, fontWeight: 800, color: g.color || "#6366f1", fontFamily: "'Syne', sans-serif" }}>{count}</div>
                </div>
                <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                  <Btn size="sm" variant="ghost" onClick={e => { e.stopPropagation(); openEdit(g); }}>Edit</Btn>
                  <Btn size="sm" variant="danger" onClick={e => { e.stopPropagation(); groupsCol.remove(g.id); }}>×</Btn>
                </div>
              </div>
            );
          })}
          {groups.length === 0 && <div style={{ textAlign: "center", color: "#555", padding: "40px 0", fontStyle: "italic" }}>No groups yet.</div>}
        </div>
      </div>

      {selected && selectedGroup && (
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
            <div style={{ width: 14, height: 14, borderRadius: "50%", background: selectedGroup.color || "#6366f1" }} />
            <h3 style={{ color: "#f0f0ff", fontSize: 16, fontWeight: 700, fontFamily: "'Syne', sans-serif" }}>{selectedGroup.name}</h3>
            <span style={{ color: "#555", fontSize: 13 }}>{groupContacts.length} contacts</span>
          </div>
          <div style={{ display: "grid", gap: 10 }}>
            {groupContacts.map(c => (
              <div key={c.id} style={{ background: "#0d0d14", border: "1px solid #1e1e2e", borderRadius: 10, padding: "14px 18px", display: "flex", alignItems: "center", gap: 12 }}>
                <Avatar name={c.name || "?"} size={36} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 700, color: "#f0f0ff", fontSize: 14 }}>{c.name}</div>
                  <div style={{ fontSize: 12, color: "#888" }}>{c.company} · {c.email}</div>
                </div>
                <StatusBadge status={c.status} />
                <Btn size="sm" variant="danger" onClick={() => removeFromGroup(c.id)}>Remove</Btn>
              </div>
            ))}
            {groupContacts.length === 0 && <div style={{ textAlign: "center", color: "#555", padding: "40px 0", fontStyle: "italic" }}>No contacts in this group yet. Edit a contact to add them.</div>}
          </div>
        </div>
      )}

      {showModal && (
        <Modal title={editing ? "Edit Group" : "New Group"} onClose={() => setShowModal(false)}>
          <Field label="Group Name" value={form.name} onChange={v => setForm(f => ({ ...f, name: v }))} required />
          <Field label="Description" value={form.description} onChange={v => setForm(f => ({ ...f, description: v }))} placeholder="What is this group for?" />
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: "block", marginBottom: 8, fontSize: 12, fontWeight: 600, color: "#888", textTransform: "uppercase", letterSpacing: "0.06em" }}>Color</label>
            <div style={{ display: "flex", gap: 8 }}>
              {COLORS.map(c => <div key={c} onClick={() => setForm(f => ({ ...f, color: c }))} style={{ width: 28, height: 28, borderRadius: "50%", background: c, cursor: "pointer", border: form.color === c ? "3px solid #fff" : "3px solid transparent", transition: "all 0.15s" }} />)}
            </div>
          </div>
          <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
            <Btn variant="ghost" onClick={() => setShowModal(false)}>Cancel</Btn>
            <Btn onClick={save} disabled={!form.name}>Save Group</Btn>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ─── EMAILS TAB ───────────────────────────────────────────────────────────────
function EmailsTab({ emails, contacts, emailsCol, gmailAccounts, gmailAccountsCol, syncing, lastSync, connectGmail, syncAll }) {
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState({ contactId: "", subject: "", body: "", direction: "sent" });

  function openNew() { setForm({ contactId: contacts[0]?.id || "", subject: "", body: "", direction: "sent" }); setShowModal(true); }
  async function save() { await emailsCol.add({ ...form, date: new Date().toISOString().slice(0, 10) }); setShowModal(false); }

  const sorted = [...emails].sort((a, b) => (b.date || "").localeCompare(a.date || ""));

  return (
    <div>
      {/* Gmail accounts panel */}
      <div style={{ background: "#0d0d14", border: "1px solid #1e1e2e", borderRadius: 12, padding: "16px 20px", marginBottom: 20 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: gmailAccounts.length > 0 ? 12 : 0 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#f0f0ff", marginBottom: 2 }}>Gmail Accounts</div>
            <div style={{ fontSize: 12, color: "#666" }}>{gmailAccounts.length > 0 ? `${gmailAccounts.length} account${gmailAccounts.length > 1 ? "s" : ""} connected · syncs every 5 min${lastSync ? ` · last: ${lastSync.toLocaleTimeString()}` : ""}` : "Connect Gmail to auto-sync emails"}</div>
          </div>
          <Btn size="sm" onClick={connectGmail}>+ Connect Gmail</Btn>
          {gmailAccounts.length > 0 && <Btn size="sm" variant="ghost" onClick={syncAll} disabled={syncing}>{syncing ? "⟳ Syncing…" : "⟳ Sync Now"}</Btn>}
        </div>
        {gmailAccounts.length > 0 && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {gmailAccounts.map(a => (
              <div key={a.id} style={{ display: "flex", alignItems: "center", gap: 6, background: "#10b98115", border: "1px solid #10b98130", borderRadius: 20, padding: "4px 12px" }}>
                <span style={{ color: "#10b981", fontSize: 10 }}>●</span>
                <span style={{ fontSize: 12, color: "#ccc" }}>{a.email}</span>
                <button onClick={() => gmailAccountsCol.remove(a.id)} style={{ background: "none", border: "none", color: "#555", cursor: "pointer", fontSize: 14, lineHeight: 1, padding: 0 }}>×</button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 20 }}>
        <Btn onClick={openNew}>+ Log Email</Btn>
      </div>
      <div style={{ display: "grid", gap: 10 }}>
        {sorted.map(e => {
          const contact = contacts.find(c => c.id === e.contactId);
          return (
            <div key={e.id} style={{ background: "#0d0d14", border: "1px solid #1e1e2e", borderRadius: 12, padding: 18, display: "flex", gap: 14, alignItems: "flex-start" }}>
              <div style={{ marginTop: 2 }}>{contact ? <Avatar name={contact.name} size={36} /> : <div style={{ width: 36, height: 36, borderRadius: "50%", background: "#222" }} />}</div>
              <div style={{ flex: 1 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4, flexWrap: "wrap" }}>
                  <span style={{ fontWeight: 700, color: "#f0f0ff", fontFamily: "'Syne', sans-serif" }}>{e.subject}</span>
                  <span style={{ fontSize: 11, padding: "2px 9px", borderRadius: 20, fontWeight: 600, background: e.direction === "sent" ? "#6366f120" : "#10b98120", color: e.direction === "sent" ? "#6366f1" : "#10b981", border: `1px solid ${e.direction === "sent" ? "#6366f140" : "#10b98140"}` }}>{e.direction}</span>
                  {e.autoSynced && <span style={{ fontSize: 10, padding: "2px 8px", borderRadius: 20, background: "#10b98110", color: "#10b981", border: "1px solid #10b98130" }}>gmail{e.gmailAccount ? ` · ${e.gmailAccount}` : ""}</span>}
                  <span style={{ fontSize: 11, color: "#555", marginLeft: "auto" }}>{e.date}</span>
                </div>
                <div style={{ fontSize: 13, color: "#888" }}>{contact ? `${contact.name} · ${contact.company}` : "Unknown"}</div>
              </div>
              <Btn size="sm" variant="danger" onClick={() => emailsCol.remove(e.id)}>×</Btn>
            </div>
          );
        })}
        {sorted.length === 0 && <div style={{ textAlign: "center", color: "#555", padding: "60px 0", fontStyle: "italic" }}>No emails yet.</div>}
      </div>
      {showModal && (
        <Modal title="Log Email" onClose={() => setShowModal(false)}>
          <Sel label="Contact" value={form.contactId} onChange={v => setForm(f => ({ ...f, contactId: v }))} options={contacts.map(c => ({ value: c.id, label: `${c.name} — ${c.company}` }))} />
          <Field label="Subject" value={form.subject} onChange={v => setForm(f => ({ ...f, subject: v }))} required />
          <Field label="Body" value={form.body} onChange={v => setForm(f => ({ ...f, body: v }))} as="textarea" />
          <Sel label="Direction" value={form.direction} onChange={v => setForm(f => ({ ...f, direction: v }))} options={[{ value: "sent", label: "Sent" }, { value: "received", label: "Received" }]} />
          <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
            <Btn variant="ghost" onClick={() => setShowModal(false)}>Cancel</Btn>
            <Btn onClick={save} disabled={!form.subject}>Save Email</Btn>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ─── MEETINGS TAB ─────────────────────────────────────────────────────────────
function MeetingsTab({ meetings, contacts, meetingsCol, calConnected, calSyncing, connectCalendar, syncCalendar }) {
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState({ contactId: "", title: "", date: "", time: "10:00 AM", duration: 30, notes: "", status: "upcoming" });

  function openNew() { setForm({ contactId: contacts[0]?.id || "", title: "", date: "", time: "10:00 AM", duration: 30, notes: "", status: "upcoming" }); setShowModal(true); }
  async function save() { await meetingsCol.add({ ...form, duration: Number(form.duration) }); setShowModal(false); }

  const upcoming = meetings.filter(m => m.status === "upcoming").sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  const past = meetings.filter(m => m.status === "completed").sort((a, b) => (b.date || "").localeCompare(a.date || ""));

  function MeetingCard({ m }) {
    const contact = contacts.find(c => c.id === m.contactId);
    const dateStr = m.date ? `${m.date.slice(5, 7)}/${m.date.slice(8, 10)}` : "--";
    return (
      <div style={{ background: "#0d0d14", border: "1px solid #1e1e2e", borderRadius: 12, padding: 18, display: "flex", gap: 14, alignItems: "flex-start" }}>
        <div style={{ background: "#6366f115", border: "1px solid #6366f130", borderRadius: 10, padding: "8px 14px", textAlign: "center", minWidth: 56 }}>
          <div style={{ fontSize: 11, color: "#6366f1", fontWeight: 700 }}>{dateStr}</div>
          <div style={{ fontSize: 18, fontWeight: 800, color: "#f0f0ff", fontFamily: "'Syne', sans-serif" }}>{m.date?.slice(0,4) || "--"}</div>
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
            <span style={{ fontWeight: 700, color: "#f0f0ff", fontFamily: "'Syne', sans-serif" }}>{m.title}</span>
            {m.autoSynced && <span style={{ fontSize: 10, padding: "2px 8px", borderRadius: 20, background: "#3b82f610", color: "#3b82f6", border: "1px solid #3b82f630" }}>calendar</span>}
          </div>
          <div style={{ fontSize: 13, color: "#888", marginBottom: 4 }}>{contact ? `${contact.name} · ${contact.company}` : "No contact linked"} · {m.time} · {m.duration}min</div>
          {m.notes && <div style={{ fontSize: 13, color: "#666", fontStyle: "italic" }}>{m.notes.slice(0, 100)}</div>}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {m.status === "upcoming" && <Btn size="sm" variant="green" onClick={() => meetingsCol.update(m.id, { status: "completed" })}>✓ Done</Btn>}
          <Btn size="sm" variant="danger" onClick={() => meetingsCol.remove(m.id)}>×</Btn>
        </div>
      </div>
    );
  }

  return (
    <div>
      {/* Google Calendar banner */}
      <div style={{ background: "#0d0d14", border: "1px solid #1e1e2e", borderRadius: 12, padding: "14px 20px", marginBottom: 20, display: "flex", alignItems: "center", gap: 12 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: calConnected ? "#10b981" : "#f0f0ff", marginBottom: 2 }}>{calConnected ? "● Google Calendar Connected" : "Connect Google Calendar"}</div>
          <div style={{ fontSize: 12, color: "#666" }}>{calConnected ? "Meetings auto-sync from your calendar" : "Auto-import meetings from Google Calendar"}</div>
        </div>
        {calConnected ? <Btn size="sm" variant="ghost" onClick={syncCalendar} disabled={calSyncing}>{calSyncing ? "⟳ Syncing…" : "⟳ Sync Now"}</Btn> : <Btn size="sm" onClick={connectCalendar}>Connect Calendar</Btn>}
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 20 }}>
        <Btn onClick={openNew}>+ Schedule Meeting</Btn>
      </div>
      {upcoming.length > 0 && <>
        <h3 style={{ color: "#9999cc", fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 12 }}>Upcoming</h3>
        <div style={{ display: "grid", gap: 10, marginBottom: 28 }}>{upcoming.map(m => <MeetingCard key={m.id} m={m} />)}</div>
      </>}
      {past.length > 0 && <>
        <h3 style={{ color: "#555", fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 12 }}>Completed</h3>
        <div style={{ display: "grid", gap: 10, opacity: 0.7 }}>{past.map(m => <MeetingCard key={m.id} m={m} />)}</div>
      </>}
      {meetings.length === 0 && <div style={{ textAlign: "center", color: "#555", padding: "60px 0", fontStyle: "italic" }}>No meetings yet.</div>}
      {showModal && (
        <Modal title="Schedule Meeting" onClose={() => setShowModal(false)}>
          <Sel label="Contact" value={form.contactId} onChange={v => setForm(f => ({ ...f, contactId: v }))} options={[{ value: "", label: "-- No contact --" }, ...contacts.map(c => ({ value: c.id, label: `${c.name} — ${c.company}` }))]} />
          <Field label="Meeting Title" value={form.title} onChange={v => setForm(f => ({ ...f, title: v }))} required />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Field label="Date" value={form.date} onChange={v => setForm(f => ({ ...f, date: v }))} type="date" />
            <Field label="Time" value={form.time} onChange={v => setForm(f => ({ ...f, time: v }))} />
          </div>
          <Field label="Duration (minutes)" value={form.duration} onChange={v => setForm(f => ({ ...f, duration: v }))} type="number" />
          <Field label="Notes" value={form.notes} onChange={v => setForm(f => ({ ...f, notes: v }))} as="textarea" />
          <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
            <Btn variant="ghost" onClick={() => setShowModal(false)}>Cancel</Btn>
            <Btn onClick={save} disabled={!form.title || !form.date}>Schedule</Btn>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ─── PITCHDECKS TAB ───────────────────────────────────────────────────────────
function PitchdecksTab({ contacts }) {
  const col = useCollection("pitchdecks");
  const [uploading, setUploading] = useState(false);
  const [analyzing, setAnalyzing] = useState(null);
  const [results, setResults] = useState({});
  const fileRef = useRef();

  async function handleUpload(e) {
    const file = e.target.files[0];
    if (!file) return;
    setUploading(true);
    try {
      const storageRef = ref(storage, `pitchdecks/${Date.now()}_${file.name}`);
      await uploadBytes(storageRef, file);
      const url = await getDownloadURL(storageRef);
      await col.add({ name: file.name, url, uploadedAt: new Date().toISOString(), size: file.size });
    } catch (e) {
      // If storage not set up, save without URL
      await col.add({ name: file.name, url: null, uploadedAt: new Date().toISOString(), size: file.size });
    }
    setUploading(false);
  }

  async function analyzeMatches(deck) {
    if (!contacts.length) return;
    setAnalyzing(deck.id);
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1000,
          messages: [{ role: "user", content: `I have a pitch deck named "${deck.name}". Based on this filename and my contacts list, suggest which contacts would be the best fit to receive this pitch deck. Return ONLY a JSON object (no markdown) with keys: "analysis" (2-3 sentence description of what the deck is likely about based on its name), "topMatches" (array of contact names from this list who would be best fits, max 5), "reasoning" (one sentence explaining why).\n\nContacts: ${contacts.map(c => `${c.name} (${c.company}, ${c.status}${c.tags?.length ? ", " + c.tags.join(", ") : ""})`).join("; ")}` }]
        })
      });
      const data = await res.json();
      const text = data.content?.map(i => i.text || "").join("") || "";
      const parsed = JSON.parse(text.replace(/```json|```/g, "").trim());
      setResults(r => ({ ...r, [deck.id]: parsed }));
    } catch (e) {
      setResults(r => ({ ...r, [deck.id]: { error: "Analysis failed. Please try again." } }));
    }
    setAnalyzing(null);
  }

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <div>
          <h3 style={{ color: "#f0f0ff", fontSize: 16, fontWeight: 700, fontFamily: "'Syne', sans-serif", marginBottom: 4 }}>Pitch Decks</h3>
          <p style={{ color: "#666", fontSize: 12 }}>Upload decks and use AI to find the best-fit contacts</p>
        </div>
        <div>
          <input ref={fileRef} type="file" accept=".pdf,.pptx,.ppt" style={{ display: "none" }} onChange={handleUpload} />
          <Btn onClick={() => fileRef.current.click()} disabled={uploading}>{uploading ? "Uploading…" : "⬆ Upload Deck"}</Btn>
        </div>
      </div>

      <div style={{ display: "grid", gap: 16 }}>
        {col.docs.map(deck => {
          const result = results[deck.id];
          const matchedContacts = result?.topMatches ? contacts.filter(c => result.topMatches.some(name => c.name?.toLowerCase().includes(name.toLowerCase()))) : [];
          return (
            <div key={deck.id} style={{ background: "#0d0d14", border: "1px solid #1e1e2e", borderRadius: 12, padding: 20 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: result ? 16 : 0 }}>
                <div style={{ width: 44, height: 44, borderRadius: 10, background: "#6366f120", border: "1px solid #6366f130", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20 }}>📊</div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 700, color: "#f0f0ff", fontFamily: "'Syne', sans-serif" }}>{deck.name}</div>
                  <div style={{ fontSize: 12, color: "#666" }}>Uploaded {new Date(deck.uploadedAt).toLocaleDateString()}{deck.size ? ` · ${(deck.size / 1024).toFixed(0)}KB` : ""}</div>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <Btn size="sm" variant="primary" onClick={() => analyzeMatches(deck)} disabled={analyzing === deck.id}>{analyzing === deck.id ? "✦ Analyzing…" : "✦ Find Best Fits"}</Btn>
                  <Btn size="sm" variant="danger" onClick={() => col.remove(deck.id)}>×</Btn>
                </div>
              </div>
              {result && !result.error && (
                <div style={{ background: "#080810", borderRadius: 10, padding: 16, marginTop: 12 }}>
                  <div style={{ fontSize: 12, color: "#888", marginBottom: 12, lineHeight: 1.6 }}>{result.analysis}</div>
                  <div style={{ fontSize: 11, fontWeight: 700, color: "#6366f1", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 10 }}>Best Fits</div>
                  <div style={{ display: "grid", gap: 8 }}>
                    {matchedContacts.length > 0 ? matchedContacts.map(c => (
                      <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", background: "#0d0d14", borderRadius: 8, border: "1px solid #1e1e2e" }}>
                        <Avatar name={c.name} size={28} />
                        <div>
                          <div style={{ fontSize: 13, fontWeight: 700, color: "#f0f0ff" }}>{c.name}</div>
                          <div style={{ fontSize: 11, color: "#666" }}>{c.company}</div>
                        </div>
                        <StatusBadge status={c.status} />
                      </div>
                    )) : (
                      <div style={{ fontSize: 13, color: "#666" }}>Suggested: {result.topMatches?.join(", ")}</div>
                    )}
                  </div>
                  {result.reasoning && <div style={{ fontSize: 12, color: "#555", marginTop: 10, fontStyle: "italic" }}>{result.reasoning}</div>}
                </div>
              )}
              {result?.error && <div style={{ color: "#ef4444", fontSize: 13, marginTop: 8 }}>{result.error}</div>}
            </div>
          );
        })}
        {col.docs.length === 0 && (
          <div style={{ textAlign: "center", color: "#555", padding: "60px 0" }}>
            <div style={{ fontSize: 40, marginBottom: 12 }}>📊</div>
            <div>No pitch decks yet. Upload one to get started.</div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── NEWS TAB ─────────────────────────────────────────────────────────────────
function NewsTab({ contacts }) {
  const [selected, setSelected] = useState(null);
  const [news, setNews] = useState({});
  const [loading, setLoading] = useState(false);

  const contact = contacts.find(c => c.id === selected);

  async function fetchNews(c) {
    if (!c) return;
    setSelected(c.id);
    if (news[c.id]) return; // cached
    setLoading(true);
    try {
      if (NEWS_API_KEY === "PASTE_YOUR_NEWS_API_KEY") {
        // Demo mode - show sample news
        setNews(n => ({ ...n, [c.id]: [
          { title: `${c.name} joins board of ${c.company}`, description: "Sample article — connect News API to see real news.", url: "#", publishedAt: new Date().toISOString(), source: { name: "Demo" } },
          { title: `${c.company} announces new partnership`, description: "This is a demo article. Get a free API key at newsapi.org and paste it at the top of this file.", url: "#", publishedAt: new Date(Date.now() - 86400000).toISOString(), source: { name: "Demo" } },
        ]}));
      } else {
        const query = encodeURIComponent(`"${c.name}" OR "${c.company}"`);
        const res = await fetch(`https://newsapi.org/v2/everything?q=${query}&sortBy=publishedAt&pageSize=10&apiKey=${NEWS_API_KEY}`);
        const data = await res.json();
        setNews(n => ({ ...n, [c.id]: data.articles || [] }));
      }
    } catch (e) {
      setNews(n => ({ ...n, [c.id]: [] }));
    }
    setLoading(false);
  }

  return (
    <div style={{ display: "grid", gridTemplateColumns: "280px 1fr", gap: 20 }}>
      <div>
        <h3 style={{ color: "#9999cc", fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 12 }}>Select Contact</h3>
        <div style={{ display: "grid", gap: 8 }}>
          {contacts.map(c => (
            <div key={c.id} onClick={() => fetchNews(c)} style={{ background: "#0d0d14", border: `1px solid ${selected === c.id ? "#6366f1" : "#1e1e2e"}`, borderRadius: 10, padding: "12px 14px", cursor: "pointer", display: "flex", alignItems: "center", gap: 10, transition: "all 0.15s" }}>
              <Avatar name={c.name || "?"} size={32} />
              <div>
                <div style={{ fontWeight: 700, color: "#f0f0ff", fontSize: 13 }}>{c.name}</div>
                <div style={{ fontSize: 11, color: "#666" }}>{c.company}</div>
              </div>
            </div>
          ))}
        </div>
        {NEWS_API_KEY === "PASTE_YOUR_NEWS_API_KEY" && (
          <div style={{ marginTop: 16, background: "#f59e0b10", border: "1px solid #f59e0b30", borderRadius: 8, padding: "10px 12px", fontSize: 11, color: "#f59e0b", lineHeight: 1.5 }}>
            ⚠️ Using demo mode. Get a free API key at <strong>newsapi.org</strong> and paste it at the top of App.tsx for real news.
          </div>
        )}
      </div>

      <div>
        {!selected && <div style={{ textAlign: "center", color: "#555", padding: "60px 0" }}><div style={{ fontSize: 40, marginBottom: 12 }}>📰</div>Select a contact to see their news</div>}
        {selected && loading && <Spinner />}
        {selected && !loading && contact && (
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
              <Avatar name={contact.name} size={40} />
              <div>
                <div style={{ fontWeight: 700, color: "#f0f0ff", fontSize: 16, fontFamily: "'Syne', sans-serif" }}>{contact.name}</div>
                <div style={{ fontSize: 13, color: "#888" }}>{contact.company}</div>
              </div>
            </div>
            <div style={{ display: "grid", gap: 12 }}>
              {(news[selected] || []).length === 0 && <div style={{ textAlign: "center", color: "#555", padding: "40px 0", fontStyle: "italic" }}>No recent news found for this contact.</div>}
              {(news[selected] || []).map((article, i) => (
                <a key={i} href={article.url} target="_blank" rel="noopener noreferrer" style={{ textDecoration: "none" }}>
                  <div style={{ background: "#0d0d14", border: "1px solid #1e1e2e", borderRadius: 12, padding: 16, transition: "border-color 0.15s" }}
                    onMouseEnter={e => e.currentTarget.style.borderColor = "#6366f1"}
                    onMouseLeave={e => e.currentTarget.style.borderColor = "#1e1e2e"}>
                    <div style={{ fontWeight: 700, color: "#f0f0ff", fontSize: 14, marginBottom: 6, lineHeight: 1.4 }}>{article.title}</div>
                    {article.description && <div style={{ fontSize: 12, color: "#888", lineHeight: 1.5, marginBottom: 8 }}>{article.description.slice(0, 150)}{article.description.length > 150 ? "…" : ""}</div>}
                    <div style={{ display: "flex", gap: 12, fontSize: 11, color: "#555" }}>
                      <span>{article.source?.name}</span>
                      <span>{new Date(article.publishedAt).toLocaleDateString()}</span>
                    </div>
                  </div>
                </a>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── OUTREACH TAB ─────────────────────────────────────────────────────────────
function OutreachTab({ contacts }) {
  const col = useCollection("outreach_log");
  const prospects = contacts.filter(c => c.status === "prospect");
  const [selected, setSelected] = useState("");
  const [tone, setTone] = useState("professional");
  const [context, setContext] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => { if (prospects.length && !selected) setSelected(prospects[0].id); }, [prospects]);
  const contact = contacts.find(c => c.id === selected);

  async function generate() {
    if (!contact) return;
    setLoading(true); setError(""); setResult(null);
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1000,
          messages: [{ role: "user", content: `Write a cold outreach email. Return ONLY JSON with keys "subject" and "body".\n\nProspect: ${contact.name}, ${contact.company}\nTags: ${(contact.tags || []).join(", ")}\nNotes: ${contact.notes || "N/A"}\nContext: ${context || "None"}\nTone: ${tone}\n\nPersonalized, concise, soft CTA for 15-min call. No placeholders.` }]
        })
      });
      const data = await res.json();
      const text = data.content?.map(i => i.text || "").join("") || "";
      setResult(JSON.parse(text.replace(/```json|```/g, "").trim()));
    } catch { setError("Failed to generate. Please try again."); }
    finally { setLoading(false); }
  }

  async function markSent() {
    if (!result || !contact) return;
    await col.add({ contactId: contact.id, contactName: contact.name, subject: result.subject, sentAt: new Date().toISOString() });
    setResult(null); setContext("");
  }

  return (
    <div style={{ maxWidth: 720, margin: "0 auto" }}>
      <div style={{ background: "linear-gradient(135deg, #6366f115, #8b5cf610)", border: "1px solid #6366f130", borderRadius: 14, padding: "20px 24px", marginBottom: 24 }}>
        <h3 style={{ margin: "0 0 4px", fontSize: 16, fontWeight: 700, color: "#f0f0ff", fontFamily: "'Syne', sans-serif" }}>✦ AI Prospect Outreach</h3>
        <p style={{ margin: 0, fontSize: 13, color: "#888" }}>Generate personalized cold emails for your prospects.</p>
      </div>
      {prospects.length === 0 ? <div style={{ textAlign: "center", color: "#555", padding: "60px 0" }}>Add contacts with "prospect" status to get started.</div> : (
        <div style={{ display: "grid", gap: 16 }}>
          <Sel label="Select Prospect" value={selected} onChange={setSelected} options={prospects.map(c => ({ value: c.id, label: `${c.name} — ${c.company}` }))} />
          {contact && <div style={{ background: "#0d0d14", border: "1px solid #1e1e2e", borderRadius: 10, padding: 16, display: "flex", gap: 12, alignItems: "center" }}>
            <Avatar name={contact.name} size={40} />
            <div><div style={{ fontWeight: 700, color: "#f0f0ff" }}>{contact.name}</div><div style={{ fontSize: 13, color: "#888" }}>{contact.company} · {contact.email}</div></div>
          </div>}
          <Sel label="Tone" value={tone} onChange={setTone} options={[{ value: "professional", label: "Professional" }, { value: "friendly", label: "Friendly" }, { value: "direct", label: "Direct & Brief" }, { value: "consultative", label: "Consultative" }]} />
          <Field label="Additional Context" value={context} onChange={setContext} as="textarea" placeholder="e.g. They recently raised Series B…" />
          <Btn onClick={generate} disabled={loading || !contact}>{loading ? "✦ Generating…" : "✦ Generate Email"}</Btn>
          {error && <div style={{ color: "#ef4444", fontSize: 13, padding: "10px 14px", background: "#ef444410", borderRadius: 8 }}>{error}</div>}
          {result && (
            <div style={{ background: "#0d0d14", border: "1px solid #6366f140", borderRadius: 12, padding: 24 }}>
              <div style={{ marginBottom: 16 }}><div style={{ fontSize: 11, fontWeight: 700, color: "#6366f1", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6 }}>Subject</div><div style={{ fontSize: 16, fontWeight: 700, color: "#f0f0ff", fontFamily: "'Syne', sans-serif" }}>{result.subject}</div></div>
              <div style={{ marginBottom: 20 }}><div style={{ fontSize: 11, fontWeight: 700, color: "#6366f1", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 10 }}>Body</div><div style={{ fontSize: 14, color: "#cccce0", lineHeight: 1.7, whiteSpace: "pre-wrap" }}>{result.body}</div></div>
              <div style={{ display: "flex", gap: 10 }}><Btn variant="green" onClick={markSent}>✓ Mark as Sent</Btn><Btn variant="ghost" onClick={generate}>↺ Regenerate</Btn></div>
            </div>
          )}
          {col.docs.length > 0 && (
            <div>
              <h3 style={{ color: "#9999cc", fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 10 }}>Sent Log</h3>
              {[...col.docs].sort((a, b) => (b.sentAt || "").localeCompare(a.sentAt || "")).map((s, i) => (
                <div key={i} style={{ background: "#0d0d14", border: "1px solid #1e1e2e", borderRadius: 8, padding: "10px 14px", display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
                  <span style={{ color: "#10b981" }}>✓</span>
                  <span style={{ fontSize: 13, color: "#ccc" }}><strong>{s.contactName}</strong> — {s.subject}</span>
                  <span style={{ marginLeft: "auto", fontSize: 11, color: "#555" }}>{s.sentAt ? new Date(s.sentAt).toLocaleDateString() : ""}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
export default function CRM() {
  const [tab, setTab] = useState("Contacts");
  const contactsCol = useCollection("contacts");
  const emailsCol = useCollection("emails");
  const meetingsCol = useCollection("meetings");
  const groupsCol = useCollection("groups");
  const gmailAccountsCol = useCollection("gmail_accounts");

  const { syncing, lastSync, connectGmail, syncAll } = useGmailSync(contactsCol.docs, emailsCol, gmailAccountsCol.docs);
  const { calConnected, syncing: calSyncing, connectCalendar, syncCalendar } = useGoogleCalendar(contactsCol.docs, meetingsCol);

  const loading = contactsCol.loading || emailsCol.loading || meetingsCol.loading || groupsCol.loading;

  const stats = [
    { label: "Contacts", value: contactsCol.docs.length, color: "#6366f1" },
    { label: "Prospects", value: contactsCol.docs.filter(c => c.status === "prospect").length, color: "#f59e0b" },
    { label: "Customers", value: contactsCol.docs.filter(c => c.status === "customer").length, color: "#10b981" },
    { label: "Upcoming", value: meetingsCol.docs.filter(m => m.status === "upcoming").length, color: "#3b82f6" },
  ];

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800&family=DM+Mono:wght@400;500&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: #080810; }
        ::-webkit-scrollbar { width: 6px; } ::-webkit-scrollbar-track { background: #0d0d14; } ::-webkit-scrollbar-thumb { background: #2a2a3a; border-radius: 3px; }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
      `}</style>
      <div style={{ minHeight: "100vh", background: "#080810", fontFamily: "'DM Mono', monospace", color: "#e0e0ff" }}>
        <div style={{ borderBottom: "1px solid #1a1a2a", padding: "18px 24px", display: "flex", alignItems: "center", gap: 16, background: "#0a0a12" }}>
          <div style={{ width: 34, height: 34, borderRadius: 10, background: "linear-gradient(135deg, #6366f1, #8b5cf6)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18 }}>◈</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: "'Syne', sans-serif", fontWeight: 800, fontSize: 18, color: "#f0f0ff", letterSpacing: "-0.02em" }}>Nucleus CRM</div>
            <div style={{ fontSize: 10, color: "#10b981", letterSpacing: "0.08em", textTransform: "uppercase" }}>● Live Cloud Sync</div>
          </div>
          <div style={{ display: "flex", gap: 16, fontSize: 11, color: "#555" }}>
            <span style={{ color: gmailAccountsCol.docs.length > 0 ? "#10b981" : "#555" }}>{gmailAccountsCol.docs.length > 0 ? `● ${gmailAccountsCol.docs.length} Gmail` : "○ Gmail"}</span>
            <span style={{ color: calConnected ? "#10b981" : "#555" }}>{calConnected ? "● Calendar" : "○ Calendar"}</span>
          </div>
        </div>

        <div style={{ padding: "24px", maxWidth: 1200, margin: "0 auto" }}>
          {firebaseConfig.apiKey === "PASTE_YOUR_API_KEY" && (
            <div style={{ background: "#f59e0b15", border: "1px solid #f59e0b40", borderRadius: 12, padding: "16px 20px", marginBottom: 24, fontSize: 13, color: "#f59e0b" }}>
              ⚠️ <strong>Setup required:</strong> Replace the <code>firebaseConfig</code> values at the top of this file with your Firebase credentials.
            </div>
          )}

          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 24 }}>
            {stats.map(s => (
              <div key={s.label} style={{ background: "#0d0d14", border: "1px solid #1a1a2a", borderRadius: 12, padding: "16px 20px" }}>
                <div style={{ fontSize: 28, fontWeight: 800, color: s.color, fontFamily: "'Syne', sans-serif", lineHeight: 1 }}>{s.value}</div>
                <div style={{ fontSize: 12, color: "#666", marginTop: 4, textTransform: "uppercase", letterSpacing: "0.06em" }}>{s.label}</div>
              </div>
            ))}
          </div>

          <div style={{ display: "flex", gap: 3, marginBottom: 24, background: "#0d0d14", border: "1px solid #1a1a2a", borderRadius: 10, padding: 4, overflowX: "auto" }}>
            {TABS.map(t => (
              <button key={t} onClick={() => setTab(t)} style={{ flex: 1, minWidth: "fit-content", padding: "9px 12px", borderRadius: 8, border: "none", background: tab === t ? "#6366f1" : "transparent", color: tab === t ? "#fff" : "#666", fontWeight: 700, cursor: "pointer", fontFamily: "'Syne', sans-serif", fontSize: 12, transition: "all 0.15s", whiteSpace: "nowrap" }}>
                {t}{t === "Outreach" && <span style={{ marginLeft: 4, background: tab === t ? "#ffffff30" : "#6366f130", color: tab === t ? "#fff" : "#6366f1", borderRadius: 20, padding: "1px 6px", fontSize: 9 }}>AI</span>}
              </button>
            ))}
          </div>

          <div style={{ animation: "fadeIn 0.2s ease" }} key={tab}>
            {loading ? <Spinner /> : <>
              {tab === "Contacts" && <ContactsTab contacts={contactsCol.docs} emails={emailsCol.docs} meetings={meetingsCol.docs} groups={groupsCol.docs} contactsCol={contactsCol} />}
              {tab === "Groups" && <GroupsTab groups={groupsCol.docs} groupsCol={groupsCol} contacts={contactsCol.docs} contactsCol={contactsCol} />}
              {tab === "Emails" && <EmailsTab emails={emailsCol.docs} contacts={contactsCol.docs} emailsCol={emailsCol} gmailAccounts={gmailAccountsCol.docs} gmailAccountsCol={gmailAccountsCol} syncing={syncing} lastSync={lastSync} connectGmail={connectGmail} syncAll={syncAll} />}
              {tab === "Meetings" && <MeetingsTab meetings={meetingsCol.docs} contacts={contactsCol.docs} meetingsCol={meetingsCol} calConnected={calConnected} calSyncing={calSyncing} connectCalendar={connectCalendar} syncCalendar={syncCalendar} />}
              {tab === "Pitchdecks" && <PitchdecksTab contacts={contactsCol.docs} />}
              {tab === "News" && <NewsTab contacts={contactsCol.docs} />}
              {tab === "Outreach" && <OutreachTab contacts={contactsCol.docs} />}
            </>}
          </div>
        </div>
      </div>
    </>
  );
}

