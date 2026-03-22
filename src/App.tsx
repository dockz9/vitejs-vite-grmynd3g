// @ts-nocheck
import { useState, useEffect, useCallback } from "react";
import { initializeApp } from "firebase/app";
import {
  getFirestore, collection, onSnapshot,
  addDoc, updateDoc, deleteDoc, doc, setDoc, getDoc
} from "firebase/firestore";

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

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

const TABS = ["Contacts", "Emails", "Meetings", "Outreach"];
const STATUS_COLORS = {
  prospect: "#f59e0b", active: "#10b981", inactive: "#6b7280", customer: "#3b82f6",
};

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
  async function add(data) { await addDoc(collection(db, name), data); }
  async function update(id, data) { await updateDoc(doc(db, name, id), data); }
  async function remove(id) { await deleteDoc(doc(db, name, id)); }
  return { docs, loading, add, update, remove };
}

// ─── GMAIL SYNC HOOK ──────────────────────────────────────────────────────────
function useGmailSync(contacts, emailsCol) {
  const [gmailToken, setGmailToken] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [lastSync, setLastSync] = useState(null);
  const [gmailConnected, setGmailConnected] = useState(false);

  useEffect(() => {
    // Load saved token from Firestore
    async function loadToken() {
      try {
        const snap = await getDoc(doc(db, "settings", "gmail"));
        if (snap.exists() && snap.data().access_token) {
          setGmailToken(snap.data().access_token);
          setGmailConnected(true);
        }
      } catch (e) {}
    }
    loadToken();
  }, []);

  function connectGmail() {
    const params = new URLSearchParams({
      client_id: GMAIL_CLIENT_ID,
      redirect_uri: window.location.origin,
      response_type: "token",
      scope: "https://www.googleapis.com/auth/gmail.readonly",
      prompt: "consent",
    });
    const popup = window.open(
      `https://accounts.google.com/o/oauth2/v2/auth?${params}`,
      "gmailAuth",
      "width=500,height=600,left=200,top=100"
    );

    const interval = setInterval(async () => {
      try {
        if (popup.closed) { clearInterval(interval); return; }
        const hash = popup.location.hash;
        if (hash && hash.includes("access_token")) {
          clearInterval(interval);
          popup.close();
          const tokenParams = new URLSearchParams(hash.slice(1));
          const token = tokenParams.get("access_token");
          setGmailToken(token);
          setGmailConnected(true);
          await setDoc(doc(db, "settings", "gmail"), { access_token: token, connected_at: new Date().toISOString() });
        }
      } catch (e) {}
    }, 500);
  }

  async function syncEmails() {
    if (!gmailToken || contacts.length === 0) return;
    setSyncing(true);
    try {
      const contactEmails = contacts.map(c => c.email?.toLowerCase()).filter(Boolean);
      const query = contactEmails.map(e => `from:${e} OR to:${e}`).join(" OR ");

      // Fetch from inbox and sent
      const [inboxRes, sentRes] = await Promise.all([
        fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=30`, {
          headers: { Authorization: `Bearer ${gmailToken}` }
        }),
        fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(`in:sent ${query}`)}&maxResults=30`, {
          headers: { Authorization: `Bearer ${gmailToken}` }
        }),
      ]);

      if (inboxRes.status === 401 || sentRes.status === 401) {
        setGmailToken(null);
        setGmailConnected(false);
        await setDoc(doc(db, "settings", "gmail"), { access_token: null });
        setSyncing(false);
        return;
      }

      const inbox = await inboxRes.json();
      const sent = await sentRes.json();

      const allIds = [
        ...(inbox.messages || []),
        ...(sent.messages || []),
      ];

      // Get already synced IDs
      const syncedIds = new Set(emailsCol.docs.filter(e => e.gmailId).map(e => e.gmailId));

      let count = 0;
      for (const msg of allIds) {
        if (syncedIds.has(msg.id)) continue;

        const detailRes = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`,
          { headers: { Authorization: `Bearer ${gmailToken}` } }
        );
        const detail = await detailRes.json();
        const headers = detail.payload?.headers || [];

        const from = headers.find(h => h.name === "From")?.value || "";
        const to = headers.find(h => h.name === "To")?.value || "";
        const subject = headers.find(h => h.name === "Subject")?.value || "(no subject)";
        const date = headers.find(h => h.name === "Date")?.value || "";

        const fromEmail = from.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/)?.[0]?.toLowerCase();
        const toEmail = to.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/)?.[0]?.toLowerCase();

        const contact = contacts.find(c =>
          c.email?.toLowerCase() === fromEmail || c.email?.toLowerCase() === toEmail
        );
        if (!contact) continue;

        const direction = contactEmails.includes(fromEmail) ? "received" : "sent";

        await emailsCol.add({
          gmailId: msg.id,
          contactId: contact.id,
          subject,
          body: "",
          date: date ? new Date(date).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10),
          direction,
          status: "read",
          autoSynced: true,
        });
        count++;
      }

      setLastSync(new Date());
    } catch (e) {
      console.error("Gmail sync error:", e);
    }
    setSyncing(false);
  }

  // Auto sync every 5 minutes when connected
  useEffect(() => {
    if (!gmailConnected || !gmailToken) return;
    syncEmails();
    const interval = setInterval(syncEmails, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [gmailConnected, gmailToken, contacts.length]);

  return { gmailConnected, syncing, lastSync, connectGmail, syncEmails };
}

function Avatar({ name, size = 36 }) {
  const initials = name.split(" ").map(n => n[0]).join("").slice(0, 2).toUpperCase();
  const colors = ["#6366f1","#ec4899","#f59e0b","#10b981","#3b82f6","#8b5cf6","#ef4444"];
  const color = colors[name.charCodeAt(0) % colors.length];
  return (
    <div style={{ width: size, height: size, borderRadius: "50%", background: color, display: "flex", alignItems: "center", justifyContent: "center", fontSize: size * 0.35, fontWeight: 700, color: "#fff", flexShrink: 0 }}>
      {initials}
    </div>
  );
}

function StatusBadge({ status }) {
  return (
    <span style={{ background: STATUS_COLORS[status] + "22", color: STATUS_COLORS[status], border: `1px solid ${STATUS_COLORS[status]}44`, borderRadius: 20, padding: "2px 10px", fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em" }}>
      {status}
    </span>
  );
}

function Modal({ title, onClose, children }) {
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <div style={{ background: "#13131a", border: "1px solid #2a2a3a", borderRadius: 16, width: "100%", maxWidth: 560, maxHeight: "90vh", overflowY: "auto", padding: 32 }}>
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
      {as === "textarea"
        ? <textarea style={s} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} />
        : <input style={s} type={type} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} />}
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
  };
  return <button onClick={onClick} disabled={disabled} style={{ ...base, ...v[variant] }}>{children}</button>;
}

function Spinner() {
  return <div style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: "80px 0", color: "#555", fontSize: 13 }}>⟳ Syncing with cloud…</div>;
}

// ─── CONTACTS ────────────────────────────────────────────────────────────────
function ContactsTab({ contacts, emails, meetings }) {
  const col = useCollection("contacts");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState(null);
  const blank = { name: "", company: "", email: "", phone: "", status: "prospect", tags: "", notes: "" };
  const [form, setForm] = useState(blank);

  const filtered = contacts.filter(c => {
    const q = search.toLowerCase();
    const match = c.name?.toLowerCase().includes(q) || c.company?.toLowerCase().includes(q) || c.email?.toLowerCase().includes(q);
    return match && (filter === "all" || c.status === filter);
  });

  function openNew() { setForm(blank); setEditing(null); setShowModal(true); }
  function openEdit(c) { setForm({ ...c, tags: (c.tags || []).join(", ") }); setEditing(c); setShowModal(true); }

  async function save() {
    const data = { ...form, tags: form.tags.split(",").map(t => t.trim()).filter(Boolean) };
    if (editing) { await col.update(editing.id, data); }
    else { await col.add(data); }
    setShowModal(false);
  }

  return (
    <div>
      <div style={{ display: "flex", gap: 12, marginBottom: 20, flexWrap: "wrap" }}>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search contacts…" style={{ flex: 1, minWidth: 180, background: "#0d0d14", border: "1px solid #2a2a3a", borderRadius: 8, padding: "10px 14px", color: "#e0e0ff", fontSize: 14, fontFamily: "inherit", outline: "none" }} />
        <select value={filter} onChange={e => setFilter(e.target.value)} style={{ background: "#0d0d14", border: "1px solid #2a2a3a", borderRadius: 8, padding: "10px 14px", color: "#e0e0ff", fontSize: 14, fontFamily: "inherit", outline: "none" }}>
          {["all","prospect","active","customer","inactive"].map(s => <option key={s} value={s}>{s === "all" ? "All Statuses" : s.charAt(0).toUpperCase() + s.slice(1)}</option>)}
        </select>
        <Btn onClick={openNew}>+ New Contact</Btn>
      </div>
      <div style={{ display: "grid", gap: 12 }}>
        {filtered.map(c => {
          const cEmails = emails.filter(e => e.contactId === c.id).length;
          const cMeetings = meetings.filter(m => m.contactId === c.id).length;
          return (
            <div key={c.id} style={{ background: "#0d0d14", border: "1px solid #1e1e2e", borderRadius: 12, padding: 20, display: "flex", alignItems: "center", gap: 16, transition: "border-color 0.15s" }}
              onMouseEnter={e => e.currentTarget.style.borderColor = "#6366f1"}
              onMouseLeave={e => e.currentTarget.style.borderColor = "#1e1e2e"}>
              <Avatar name={c.name || "?"} size={44} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4, flexWrap: "wrap" }}>
                  <span style={{ fontWeight: 700, fontSize: 15, color: "#f0f0ff", fontFamily: "'Syne', sans-serif" }}>{c.name}</span>
                  <StatusBadge status={c.status} />
                </div>
                <div style={{ fontSize: 13, color: "#888", marginBottom: 6 }}>{c.company} · {c.email}</div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {(c.tags || []).map(t => <span key={t} style={{ background: "#6366f110", color: "#6366f1", border: "1px solid #6366f130", borderRadius: 20, padding: "1px 9px", fontSize: 11, fontWeight: 600 }}>{t}</span>)}
                </div>
              </div>
              <div style={{ display: "flex", gap: 20, color: "#666", fontSize: 12, textAlign: "center" }}>
                <div><div style={{ fontSize: 18, fontWeight: 700, color: "#9999cc" }}>{cEmails}</div>emails</div>
                <div><div style={{ fontSize: 18, fontWeight: 700, color: "#9999cc" }}>{cMeetings}</div>meetings</div>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <Btn size="sm" variant="ghost" onClick={() => openEdit(c)}>Edit</Btn>
                <Btn size="sm" variant="danger" onClick={() => col.remove(c.id)}>×</Btn>
              </div>
            </div>
          );
        })}
        {filtered.length === 0 && <div style={{ textAlign: "center", color: "#555", padding: "60px 0", fontStyle: "italic" }}>No contacts found.</div>}
      </div>
      {showModal && (
        <Modal title={editing ? "Edit Contact" : "New Contact"} onClose={() => setShowModal(false)}>
          <Field label="Full Name" value={form.name} onChange={v => setForm(f => ({ ...f, name: v }))} required />
          <Field label="Company" value={form.company} onChange={v => setForm(f => ({ ...f, company: v }))} />
          <Field label="Email" value={form.email} onChange={v => setForm(f => ({ ...f, email: v }))} type="email" />
          <Field label="Phone" value={form.phone} onChange={v => setForm(f => ({ ...f, phone: v }))} />
          <Sel label="Status" value={form.status} onChange={v => setForm(f => ({ ...f, status: v }))} options={["prospect","active","customer","inactive"].map(s => ({ value: s, label: s.charAt(0).toUpperCase() + s.slice(1) }))} />
          <Field label="Tags (comma-separated)" value={form.tags} onChange={v => setForm(f => ({ ...f, tags: v }))} placeholder="e.g. enterprise, warm lead" />
          <Field label="Notes" value={form.notes} onChange={v => setForm(f => ({ ...f, notes: v }))} as="textarea" />
          <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
            <Btn variant="ghost" onClick={() => setShowModal(false)}>Cancel</Btn>
            <Btn onClick={save} disabled={!form.name || !form.email}>Save Contact</Btn>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ─── EMAILS ──────────────────────────────────────────────────────────────────
function EmailsTab({ emails, contacts, gmailConnected, syncing, lastSync, connectGmail, syncEmails }) {
  const col = useCollection("emails");
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState({ contactId: "", subject: "", body: "", direction: "sent" });

  function openNew() { setForm({ contactId: contacts[0]?.id || "", subject: "", body: "", direction: "sent" }); setShowModal(true); }
  async function save() {
    await col.add({ ...form, date: new Date().toISOString().slice(0, 10) });
    setShowModal(false);
  }

  const sorted = [...emails].sort((a, b) => (b.date || "").localeCompare(a.date || ""));

  return (
    <div>
      {/* Gmail sync banner */}
      <div style={{ background: gmailConnected ? "#10b98115" : "#6366f115", border: `1px solid ${gmailConnected ? "#10b98130" : "#6366f130"}`, borderRadius: 12, padding: "14px 20px", marginBottom: 20, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: gmailConnected ? "#10b981" : "#6366f1", marginBottom: 2 }}>
            {gmailConnected ? "● Gmail Connected" : "Connect Gmail for Auto-Sync"}
          </div>
          <div style={{ fontSize: 12, color: "#666" }}>
            {gmailConnected
              ? `Emails auto-sync every 5 minutes${lastSync ? ` · Last sync: ${lastSync.toLocaleTimeString()}` : ""}`
              : "Automatically log all emails to/from your contacts"}
          </div>
        </div>
        {gmailConnected
          ? <Btn size="sm" variant="ghost" onClick={syncEmails} disabled={syncing}>{syncing ? "⟳ Syncing…" : "⟳ Sync Now"}</Btn>
          : <Btn size="sm" onClick={connectGmail}>Connect Gmail</Btn>}
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
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4, flexWrap: "wrap" }}>
                  <span style={{ fontWeight: 700, color: "#f0f0ff", fontFamily: "'Syne', sans-serif" }}>{e.subject}</span>
                  <span style={{ fontSize: 11, padding: "2px 9px", borderRadius: 20, fontWeight: 600, background: e.direction === "sent" ? "#6366f120" : "#10b98120", color: e.direction === "sent" ? "#6366f1" : "#10b981", border: `1px solid ${e.direction === "sent" ? "#6366f140" : "#10b98140"}` }}>{e.direction}</span>
                  {e.autoSynced && <span style={{ fontSize: 10, padding: "2px 8px", borderRadius: 20, background: "#10b98110", color: "#10b981", border: "1px solid #10b98130" }}>gmail</span>}
                  <span style={{ fontSize: 11, color: "#555", marginLeft: "auto" }}>{e.date}</span>
                </div>
                <div style={{ fontSize: 13, color: "#888", marginBottom: 4 }}>{contact ? `${contact.name} · ${contact.company}` : "Unknown"}</div>
                {e.body && <div style={{ fontSize: 13, color: "#666", fontStyle: "italic" }}>{(e.body || "").slice(0, 120)}{(e.body || "").length > 120 ? "…" : ""}</div>}
              </div>
              <Btn size="sm" variant="danger" onClick={() => col.remove(e.id)}>×</Btn>
            </div>
          );
        })}
        {sorted.length === 0 && <div style={{ textAlign: "center", color: "#555", padding: "60px 0", fontStyle: "italic" }}>No emails yet. Connect Gmail to auto-sync!</div>}
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

// ─── MEETINGS ─────────────────────────────────────────────────────────────────
function MeetingsTab({ meetings, contacts }) {
  const col = useCollection("meetings");
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState({ contactId: "", title: "", date: "", time: "10:00 AM", duration: 30, notes: "", status: "upcoming" });

  function openNew() { setForm({ contactId: contacts[0]?.id || "", title: "", date: "", time: "10:00 AM", duration: 30, notes: "", status: "upcoming" }); setShowModal(true); }
  async function save() {
    await col.add({ ...form, duration: Number(form.duration) });
    setShowModal(false);
  }

  const upcoming = meetings.filter(m => m.status === "upcoming").sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  const past = meetings.filter(m => m.status === "completed").sort((a, b) => (b.date || "").localeCompare(a.date || ""));

  function MeetingCard({ m }) {
    const contact = contacts.find(c => c.id === m.contactId);
    const dateStr = m.date ? `${m.date.slice(5, 7)}/${m.date.slice(8, 10)}` : "--";
    const yearStr = m.date ? m.date.slice(2, 4) : "--";
    return (
      <div style={{ background: "#0d0d14", border: "1px solid #1e1e2e", borderRadius: 12, padding: 18, display: "flex", gap: 14, alignItems: "flex-start" }}>
        <div style={{ background: "#6366f115", border: "1px solid #6366f130", borderRadius: 10, padding: "8px 14px", textAlign: "center", minWidth: 56 }}>
          <div style={{ fontSize: 11, color: "#6366f1", fontWeight: 700 }}>{dateStr}</div>
          <div style={{ fontSize: 20, fontWeight: 800, color: "#f0f0ff", fontFamily: "'Syne', sans-serif" }}>{yearStr}</div>
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 700, color: "#f0f0ff", fontFamily: "'Syne', sans-serif", marginBottom: 4 }}>{m.title}</div>
          <div style={{ fontSize: 13, color: "#888", marginBottom: 4 }}>{contact ? `${contact.name} · ${contact.company}` : "Unknown"} · {m.time} · {m.duration}min</div>
          {m.notes && <div style={{ fontSize: 13, color: "#666", fontStyle: "italic" }}>{m.notes}</div>}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {m.status === "upcoming" && <Btn size="sm" variant="green" onClick={() => col.update(m.id, { status: "completed" })}>✓ Done</Btn>}
          <Btn size="sm" variant="danger" onClick={() => col.remove(m.id)}>×</Btn>
        </div>
      </div>
    );
  }

  return (
    <div>
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
          <Sel label="Contact" value={form.contactId} onChange={v => setForm(f => ({ ...f, contactId: v }))} options={contacts.map(c => ({ value: c.id, label: `${c.name} — ${c.company}` }))} />
          <Field label="Meeting Title" value={form.title} onChange={v => setForm(f => ({ ...f, title: v }))} required />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Field label="Date" value={form.date} onChange={v => setForm(f => ({ ...f, date: v }))} type="date" />
            <Field label="Time" value={form.time} onChange={v => setForm(f => ({ ...f, time: v }))} placeholder="10:00 AM" />
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

// ─── OUTREACH ─────────────────────────────────────────────────────────────────
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
          messages: [{ role: "user", content: `Write a cold outreach email to a prospect. Return ONLY a JSON object (no markdown, no backticks) with keys "subject" and "body".\n\nProspect: ${contact.name}, ${contact.company}\nTags: ${(contact.tags || []).join(", ")}\nNotes: ${contact.notes || "N/A"}\nExtra context: ${context || "None"}\nTone: ${tone}\n\nMake it concise, personalized, and end with a soft CTA for a 15-min call. Do not use placeholders.` }]
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
        <p style={{ margin: 0, fontSize: 13, color: "#888" }}>Generate personalized cold emails — logged to the cloud instantly.</p>
      </div>
      {prospects.length === 0
        ? <div style={{ textAlign: "center", color: "#555", padding: "60px 0" }}><div style={{ fontSize: 32, marginBottom: 12 }}>📭</div>Add contacts with "prospect" status to get started.</div>
        : <div style={{ display: "grid", gap: 16 }}>
          <Sel label="Select Prospect" value={selected} onChange={setSelected} options={prospects.map(c => ({ value: c.id, label: `${c.name} — ${c.company}` }))} />
          {contact && (
            <div style={{ background: "#0d0d14", border: "1px solid #1e1e2e", borderRadius: 10, padding: 16, display: "flex", gap: 12, alignItems: "center" }}>
              <Avatar name={contact.name} size={40} />
              <div>
                <div style={{ fontWeight: 700, color: "#f0f0ff" }}>{contact.name}</div>
                <div style={{ fontSize: 13, color: "#888" }}>{contact.company} · {contact.email}</div>
              </div>
            </div>
          )}
          <Sel label="Tone" value={tone} onChange={setTone} options={[
            { value: "professional", label: "Professional & Formal" },
            { value: "friendly", label: "Friendly & Conversational" },
            { value: "direct", label: "Direct & Brief" },
            { value: "consultative", label: "Consultative & Thoughtful" },
          ]} />
          <Field label="Additional Context (optional)" value={context} onChange={setContext} as="textarea" placeholder="e.g. They recently raised Series B…" />
          <Btn onClick={generate} disabled={loading || !contact}>{loading ? "✦ Generating…" : "✦ Generate Email"}</Btn>
          {error && <div style={{ color: "#ef4444", fontSize: 13, padding: "10px 14px", background: "#ef444410", borderRadius: 8, border: "1px solid #ef444430" }}>{error}</div>}
          {result && (
            <div style={{ background: "#0d0d14", border: "1px solid #6366f140", borderRadius: 12, padding: 24 }}>
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: "#6366f1", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6 }}>Subject</div>
                <div style={{ fontSize: 16, fontWeight: 700, color: "#f0f0ff", fontFamily: "'Syne', sans-serif" }}>{result.subject}</div>
              </div>
              <div style={{ marginBottom: 20 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: "#6366f1", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 10 }}>Body</div>
                <div style={{ fontSize: 14, color: "#cccce0", lineHeight: 1.7, whiteSpace: "pre-wrap" }}>{result.body}</div>
              </div>
              <div style={{ display: "flex", gap: 10 }}>
                <Btn variant="green" onClick={markSent}>✓ Mark as Sent</Btn>
                <Btn variant="ghost" onClick={generate}>↺ Regenerate</Btn>
              </div>
            </div>
          )}
          {col.docs.length > 0 && (
            <div>
              <h3 style={{ color: "#9999cc", fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 10 }}>Sent Outreach Log</h3>
              <div style={{ display: "grid", gap: 8 }}>
                {[...col.docs].sort((a, b) => (b.sentAt || "").localeCompare(a.sentAt || "")).map((s, i) => (
                  <div key={i} style={{ background: "#0d0d14", border: "1px solid #1e1e2e", borderRadius: 8, padding: "10px 14px", display: "flex", alignItems: "center", gap: 10 }}>
                    <span style={{ color: "#10b981" }}>✓</span>
                    <span style={{ fontSize: 13, color: "#ccc" }}><strong>{s.contactName}</strong> — {s.subject}</span>
                    <span style={{ marginLeft: "auto", fontSize: 11, color: "#555" }}>{s.sentAt ? new Date(s.sentAt).toLocaleDateString() : ""}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>}
    </div>
  );
}

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
export default function CRM() {
  const [tab, setTab] = useState("Contacts");
  const contactsCol = useCollection("contacts");
  const emailsCol = useCollection("emails");
  const meetingsCol = useCollection("meetings");
  const { gmailConnected, syncing, lastSync, connectGmail, syncEmails } = useGmailSync(contactsCol.docs, emailsCol);

  const loading = contactsCol.loading || emailsCol.loading || meetingsCol.loading;

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
          <div style={{ fontSize: 12, color: gmailConnected ? "#10b981" : "#555" }}>
            {gmailConnected ? "● Gmail Syncing" : "○ Gmail Not Connected"}
          </div>
        </div>

        <div style={{ padding: "24px", maxWidth: 1100, margin: "0 auto" }}>
          {firebaseConfig.apiKey === "PASTE_YOUR_API_KEY" && (
            <div style={{ background: "#f59e0b15", border: "1px solid #f59e0b40", borderRadius: 12, padding: "16px 20px", marginBottom: 24, fontSize: 13, color: "#f59e0b", lineHeight: 1.6 }}>
              ⚠️ <strong>Setup required:</strong> Replace the <code>firebaseConfig</code> values at the top of this file with your Firebase project credentials.
            </div>
          )}
          {GMAIL_CLIENT_ID === "PASTE_YOUR_GMAIL_CLIENT_ID" && (
            <div style={{ background: "#3b82f615", border: "1px solid #3b82f640", borderRadius: 12, padding: "16px 20px", marginBottom: 24, fontSize: 13, color: "#3b82f6", lineHeight: 1.6 }}>
              ℹ️ <strong>Gmail sync:</strong> Replace <code>PASTE_YOUR_GMAIL_CLIENT_ID</code> at the top of this file with your Google OAuth Client ID to enable Gmail auto-sync.
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
          <div style={{ display: "flex", gap: 4, marginBottom: 24, background: "#0d0d14", border: "1px solid #1a1a2a", borderRadius: 10, padding: 4 }}>
            {TABS.map(t => (
              <button key={t} onClick={() => setTab(t)} style={{ flex: 1, padding: "9px 0", borderRadius: 8, border: "none", background: tab === t ? "#6366f1" : "transparent", color: tab === t ? "#fff" : "#666", fontWeight: 700, cursor: "pointer", fontFamily: "'Syne', sans-serif", fontSize: 13, transition: "all 0.15s" }}>
                {t}{t === "Outreach" && <span style={{ marginLeft: 6, background: tab === t ? "#ffffff30" : "#6366f130", color: tab === t ? "#fff" : "#6366f1", borderRadius: 20, padding: "1px 7px", fontSize: 10 }}>AI</span>}
              </button>
            ))}
          </div>
          <div style={{ animation: "fadeIn 0.2s ease" }} key={tab}>
            {loading ? <Spinner /> : <>
              {tab === "Contacts" && <ContactsTab contacts={contactsCol.docs} emails={emailsCol.docs} meetings={meetingsCol.docs} />}
              {tab === "Emails" && <EmailsTab emails={emailsCol.docs} contacts={contactsCol.docs} gmailConnected={gmailConnected} syncing={syncing} lastSync={lastSync} connectGmail={connectGmail} syncEmails={syncEmails} />}
              {tab === "Meetings" && <MeetingsTab meetings={meetingsCol.docs} contacts={contactsCol.docs} />}
              {tab === "Outreach" && <OutreachTab contacts={contactsCol.docs} />}
            </>}
          </div>
        </div>
      </div>
    </>
  );
}

