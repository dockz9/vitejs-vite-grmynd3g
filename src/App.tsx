// @ts-nocheck
import { useState, useEffect, useRef, useCallback } from "react";
import { initializeApp } from "firebase/app";
import {
  getFirestore, collection, onSnapshot,
  addDoc, updateDoc, deleteDoc, doc, setDoc, getDoc,
  query, orderBy, limit, startAfter, getDocs, getCountFromServer
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
const NEWS_API_KEY = "52d60ad3da4143bdbe827547aa3d406e";
// ─────────────────────────────────────────────────────────────────────────────

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const storage = getStorage(app);

const TABS = ["Dashboard", "Contacts", "Companies", "Groups", "Emails", "Meetings", "Pipeline", "Pitchdecks", "News", "Outreach"];
const STATUS_COLORS = {
  prospect: "#f59e0b", active: "#10b981", inactive: "#6b7280", customer: "#3b82f6",
};

// ─── FIRESTORE HOOK ───────────────────────────────────────────────────────────
// Simple hook for small collections (emails, meetings, groups etc)
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

// Paginated hook for large collections like contacts
const PAGE_SIZE = 50;
function usePaginatedContacts() {
  const [docs, setDocs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [totalCount, setTotalCount] = useState(0);
  const [page, setPage] = useState(0);
  const [lastDocs, setLastDocs] = useState({}); // cache of last doc per page
  const [search, setSearchState] = useState("");
  const searchTimeout = useRef(null);

  // Get total count once
  useEffect(() => {
    getCountFromServer(collection(db, "contacts")).then(snap => {
      setTotalCount(snap.data().count);
    }).catch(() => {});
  }, []);

  // Load page whenever page or search changes
  useEffect(() => {
    setLoading(true);
    let q;
    if (search) {
      q = query(collection(db, "contacts"), limit(500));
    } else if (page > 0 && lastDocs[page - 1]) {
      q = query(collection(db, "contacts"), startAfter(lastDocs[page - 1]), limit(PAGE_SIZE));
    } else {
      q = query(collection(db, "contacts"), limit(PAGE_SIZE));
    }

    getDocs(q).then(snap => {
      let results = snap.docs.map(d => ({ id: d.id, ...d.data() }));

      // Save last doc for next page cursor
      if (!search && snap.docs.length > 0) {
        setLastDocs(prev => ({ ...prev, [page]: snap.docs[snap.docs.length - 1] }));
      }

      if (search) {
        const sq = search.toLowerCase();
        results = results.filter(c =>
          c.name?.toLowerCase().includes(sq) ||
          c.firstName?.toLowerCase().includes(sq) ||
          c.lastName?.toLowerCase().includes(sq) ||
          c.company?.toLowerCase().includes(sq) ||
          c.email?.toLowerCase().includes(sq)
        );
      }

      // Sort client-side by lastName then firstName
      results.sort((a, b) => {
        const aLast = (a.lastName || a.name || "").toLowerCase();
        const bLast = (b.lastName || b.name || "").toLowerCase();
        if (aLast !== bLast) return aLast.localeCompare(bLast);
        const aFirst = (a.firstName || "").toLowerCase();
        const bFirst = (b.firstName || "").toLowerCase();
        return aFirst.localeCompare(bFirst);
      });

      setDocs(results);
      setLoading(false);
    }).catch(err => {
      console.error("Firestore error:", err);
      setLoading(false);
    });
  }, [page, search]);

  function nextPage() {
    if (lastDocs[page]) setPage(p => p + 1);
  }
  function prevPage() { setPage(p => Math.max(0, p - 1)); }

  function doSearch(val) {
    clearTimeout(searchTimeout.current);
    searchTimeout.current = setTimeout(() => {
      setSearchState(val);
      setPage(0);
    }, 400);
  }

  async function add(data) {
    const ref = await addDoc(collection(db, "contacts"), data);
    setTotalCount(c => c + 1);
    return ref;
  }
  async function update(id, data) { await updateDoc(doc(db, "contacts", id), data); }
  async function remove(id) {
    await deleteDoc(doc(db, "contacts", id));
    setTotalCount(c => c - 1);
    setDocs(d => d.filter(x => x.id !== id));
  }

  const totalPages = Math.ceil(totalCount / PAGE_SIZE);

  return { docs, loading, totalCount, totalPages, page, nextPage, prevPage, add, update, remove, doSearch, search };
}

// Hook to load all companies from contacts efficiently
function useCompanies() {
  const [companies, setCompanies] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadAllCompanies() {
      setLoading(true);
      const companyMap = {};
      let lastDoc = null;
      const BATCH = 500;

      while (true) {
        const q = lastDoc
          ? query(collection(db, "contacts"), startAfter(lastDoc), limit(BATCH))
          : query(collection(db, "contacts"), limit(BATCH));
        const snap = await getDocs(q);
        if (snap.empty) break;

        snap.docs.forEach(d => {
          const data = d.data();
          const co = data.company?.trim();
          if (!co) return;
          if (!companyMap[co]) companyMap[co] = { name: co, contacts: [], companyOnly: null };
          const hasPersonalName = data.firstName || data.lastName || (data.name && data.name !== co);
          if (!hasPersonalName) companyMap[co].companyOnly = { id: d.id, ...data };
          else companyMap[co].contacts.push({ id: d.id, ...data });
        });

        lastDoc = snap.docs[snap.docs.length - 1];
        if (snap.docs.length < BATCH) break;
        await new Promise(r => setTimeout(r, 200));
      }

      setCompanies(Object.values(companyMap).sort((a, b) => a.name.localeCompare(b.name)));
      setLoading(false);
    }

    loadAllCompanies();
  }, []);

  return { companies, loading };
}

// Hook to load all imported groups from all contacts
function useImportedGroups() {
  const [groupMap, setGroupMap] = useState({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadAllGroups() {
      setLoading(true);
      const map = {};
      let lastDoc = null;
      const BATCH = 500;

      while (true) {
        const q = lastDoc
          ? query(collection(db, "contacts"), startAfter(lastDoc), limit(BATCH))
          : query(collection(db, "contacts"), limit(BATCH));
        const snap = await getDocs(q);
        if (snap.empty) break;

        snap.docs.forEach(d => {
          const data = d.data();
          const g = data.importGroups?.trim();
          if (!g) return;
          if (!map[g]) map[g] = [];
          map[g].push({ id: d.id, ...data });
        });

        lastDoc = snap.docs[snap.docs.length - 1];
        if (snap.docs.length < BATCH) break;
        await new Promise(r => setTimeout(r, 200));
      }

      setGroupMap(map);
      setLoading(false);
    }

    loadAllGroups();
  }, []);

  return { groupMap, loading };
}

// ─── RELATIONSHIP HEALTH SCORE ────────────────────────────────────────────────
function calcHealthScore(contact, emails, meetings) {
  const now = Date.now();
  const day = 86400000;
  const cEmails = emails.filter(e => e.contactId === contact.id);
  const cMeetings = meetings.filter(m => m.contactId === contact.id);
  const allDates = [
    ...cEmails.map(e => e.date ? new Date(e.date).getTime() : 0),
    ...cMeetings.map(m => m.date ? new Date(m.date).getTime() : 0),
  ].filter(Boolean).sort((a, b) => b - a);
  if (allDates.length === 0) return { score: 0, label: "Silent", color: "#6b7280", daysSince: null };
  const daysSince = Math.floor((now - allDates[0]) / day);
  const frequency = allDates.length;
  let score = 100;
  if (daysSince > 90) score -= 60;
  else if (daysSince > 60) score -= 40;
  else if (daysSince > 30) score -= 20;
  else if (daysSince > 14) score -= 10;
  if (frequency < 2) score -= 15;
  else if (frequency >= 5) score += 10;
  score = Math.max(0, Math.min(100, score));
  let label, color;
  if (score >= 75) { label = "Strong"; color = "#10b981"; }
  else if (score >= 50) { label = "Active"; color = "#3b82f6"; }
  else if (score >= 25) { label = "Cooling"; color = "#f59e0b"; }
  else { label = "Cold"; color = "#ef4444"; }
  return { score, label, color, daysSince };
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
          clearInterval(interval); popup.close();
          const token = new URLSearchParams(hash.slice(1)).get("access_token");
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
          fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=50`, { headers: { Authorization: `Bearer ${account.access_token}` } }),
          fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(`in:sent ${query}`)}&maxResults=50`, { headers: { Authorization: `Bearer ${account.access_token}` } }),
        ]);
        if (inboxRes.status === 401) continue;
        const inbox = await inboxRes.json();
        const sent = await sentRes.json();
        for (const msg of [...(inbox.messages || []), ...(sent.messages || [])]) {
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
      } catch (e) {}
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
    const params = new URLSearchParams({ client_id: GMAIL_CLIENT_ID, redirect_uri: window.location.origin, response_type: "token", scope: "https://www.googleapis.com/auth/calendar.readonly", prompt: "consent" });
    const popup = window.open(`https://accounts.google.com/o/oauth2/v2/auth?${params}`, "calAuth", "width=500,height=600,left=200,top=100");
    const interval = setInterval(async () => {
      try {
        if (popup.closed) { clearInterval(interval); return; }
        const hash = popup.location.hash;
        if (hash && hash.includes("access_token")) {
          clearInterval(interval); popup.close();
          const token = new URLSearchParams(hash.slice(1)).get("access_token");
          setCalToken(token); setCalConnected(true);
          await setDoc(doc(db, "settings", "calendar"), { access_token: token, connected_at: new Date().toISOString() });
          await syncCalendarWithToken(token);
        }
      } catch (e) {}
    }, 500);
  }

  async function syncCalendarWithToken(token) {
    setSyncing(true);
    try {
      const now = new Date();
      const twoWeeksAgo = new Date(now - 14 * 86400000).toISOString();
      const twoWeeksAhead = new Date(now.getTime() + 14 * 86400000).toISOString();
      const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${twoWeeksAgo}&timeMax=${twoWeeksAhead}&maxResults=50&singleEvents=true&orderBy=startTime`, { headers: { Authorization: `Bearer ${token}` } });
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
    } catch (e) {}
    setSyncing(false);
  }

  return { calConnected, syncing, connectCalendar, syncCalendar: () => calToken && syncCalendarWithToken(calToken) };
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

function HealthBar({ score, color, label, size = "md" }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <div style={{ flex: 1, height: size === "sm" ? 4 : 6, background: "#1e1e2e", borderRadius: 10, overflow: "hidden" }}>
        <div style={{ width: `${score}%`, height: "100%", background: color, borderRadius: 10, transition: "width 0.5s ease" }} />
      </div>
      <span style={{ fontSize: size === "sm" ? 10 : 11, fontWeight: 700, color, minWidth: 40 }}>{label}</span>
    </div>
  );
}

function Modal({ title, onClose, children, wide }) {
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: "#13131a", border: "1px solid #2a2a3a", borderRadius: 16, width: "100%", maxWidth: wide ? 800 : 560, maxHeight: "90vh", overflowY: "auto", padding: 32 }}>
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

// ─── AI HELPER ────────────────────────────────────────────────────────────────
async function callClaude(prompt, maxTokens = 1000) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] })
  });
  const data = await res.json();
  return data.content?.map(i => i.text || "").join("") || "";
}

async function callClaudeJSON(prompt, maxTokens = 1000) {
  const text = await callClaude(prompt, maxTokens);
  return JSON.parse(text.replace(/```json|```/g, "").trim());
}

// ─── DASHBOARD TAB ────────────────────────────────────────────────────────────
function DashboardTab({ contacts, emails, meetings, emailsCol }) {
  const [nextActions, setNextActions] = useState(null);
  const [loadingActions, setLoadingActions] = useState(false);
  const [triageResults, setTriageResults] = useState(null);
  const [loadingTriage, setLoadingTriage] = useState(false);
  const [sentimentResults, setSentimentResults] = useState(null);
  const [loadingSentiment, setLoadingSentiment] = useState(false);

  // Compute health scores for all contacts
  const contactsWithHealth = contacts.map(c => ({
    ...c,
    health: calcHealthScore(c, emails, meetings)
  })).sort((a, b) => a.health.score - b.health.score);

  const coldContacts = contactsWithHealth.filter(c => c.health.score < 50);
  const strongContacts = contactsWithHealth.filter(c => c.health.score >= 75);
  const upcomingMeetings = meetings.filter(m => m.status === "upcoming").sort((a, b) => (a.date || "").localeCompare(b.date || "")).slice(0, 3);

  async function getNextActions() {
    setLoadingActions(true);
    try {
      const context = contacts.slice(0, 20).map(c => {
        const h = calcHealthScore(c, emails, meetings);
        const lastEmail = emails.filter(e => e.contactId === c.id).sort((a, b) => b.date?.localeCompare(a.date || "")).slice(0, 1)[0];
        return `${c.name} (${c.company}, ${c.status}, health: ${h.label}, days since contact: ${h.daysSince ?? "never"}, last email: ${lastEmail?.subject || "none"})`;
      }).join("\n");
      const result = await callClaudeJSON(`You are a CRM advisor. Based on these contacts and their relationship health, suggest the top 5 next best actions. Return ONLY a JSON array of objects with keys: "contactName", "action", "reason", "priority" (high/medium/low).\n\nContacts:\n${context}`);
      setNextActions(result);
    } catch (e) { setNextActions([]); }
    setLoadingActions(false);
  }

  async function triageEmails() {
    setLoadingTriage(true);
    try {
      const recentEmails = emails.filter(e => e.direction === "received").sort((a, b) => (b.date || "").localeCompare(a.date || "")).slice(0, 20);
      if (recentEmails.length === 0) { setTriageResults({ urgent: [], later: [], trash: [] }); setLoadingTriage(false); return; }
      const emailList = recentEmails.map((e, i) => {
        const contact = contacts.find(c => c.id === e.contactId);
        return `${i}: Subject: "${e.subject}" | From: ${contact?.name || "Unknown"} (${contact?.status || "unknown"}) | Date: ${e.date}`;
      }).join("\n");
      const result = await callClaudeJSON(`Triage these CRM emails into three categories. Return ONLY JSON with keys "urgent" (array of indices - needs response today), "later" (array of indices - can wait), "trash" (array of indices - newsletters/spam/irrelevant). Be aggressive with trash.\n\nEmails:\n${emailList}`);
      const categorized = {
        urgent: (result.urgent || []).map(i => recentEmails[i]).filter(Boolean),
        later: (result.later || []).map(i => recentEmails[i]).filter(Boolean),
        trash: (result.trash || []).map(i => recentEmails[i]).filter(Boolean),
      };
      setTriageResults(categorized);
    } catch (e) { setTriageResults({ urgent: [], later: [], trash: [] }); }
    setLoadingTriage(false);
  }

  async function analyzeSentiment() {
    setLoadingSentiment(true);
    try {
      const contactsWithEmails = contacts.filter(c => emails.some(e => e.contactId === c.id)).slice(0, 10);
      const context = contactsWithEmails.map(c => {
        const cEmails = emails.filter(e => e.contactId === c.id).sort((a, b) => (b.date || "").localeCompare(a.date || "")).slice(0, 5);
        return `${c.name} (${c.company}): ${cEmails.map(e => `[${e.direction}] "${e.subject}"`).join(", ")}`;
      }).join("\n");
      const result = await callClaudeJSON(`Analyze relationship sentiment based on email patterns. Return ONLY a JSON array of objects with keys: "contactName", "sentiment" (Warming/Neutral/Cooling/Cold), "trend" (up/flat/down), "insight" (one short sentence).\n\nContact email history:\n${context}`);
      setSentimentResults(result);
    } catch (e) { setSentimentResults([]); }
    setLoadingSentiment(false);
  }

  const PRIORITY_COLORS = { high: "#ef4444", medium: "#f59e0b", low: "#10b981" };

  return (
    <div style={{ display: "grid", gap: 24 }}>

      {/* Stats row */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
        {[
          { label: "Total contacts", value: contacts.length, color: "#6366f1" },
          { label: "Cold relationships", value: coldContacts.length, color: "#ef4444" },
          { label: "Strong relationships", value: strongContacts.length, color: "#10b981" },
          { label: "Upcoming meetings", value: upcomingMeetings.length, color: "#3b82f6" },
        ].map(s => (
          <div key={s.label} style={{ background: "#0d0d14", border: "1px solid #1a1a2a", borderRadius: 12, padding: "16px 20px" }}>
            <div style={{ fontSize: 28, fontWeight: 800, color: s.color, fontFamily: "'Syne', sans-serif", lineHeight: 1 }}>{s.value}</div>
            <div style={{ fontSize: 12, color: "#666", marginTop: 4 }}>{s.label}</div>
          </div>
        ))}
      </div>

      {/* Relationship health overview */}
      <div style={{ background: "#0d0d14", border: "1px solid #1a1a2a", borderRadius: 12, padding: 20 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <div>
            <div style={{ fontWeight: 700, color: "#f0f0ff", fontFamily: "'Syne', sans-serif", marginBottom: 4 }}>Relationship Health</div>
            <div style={{ fontSize: 12, color: "#666" }}>Based on email & meeting frequency</div>
          </div>
        </div>
        <div style={{ display: "grid", gap: 10 }}>
          {contactsWithHealth.slice(0, 8).map(c => (
            <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <Avatar name={c.name || "?"} size={28} />
              <div style={{ width: 120, fontSize: 13, color: "#ccc", fontWeight: 600, flexShrink: 0 }}>{c.name}</div>
              <div style={{ flex: 1 }}>
                <HealthBar score={c.health.score} color={c.health.color} label={c.health.label} size="sm" />
              </div>
              <div style={{ fontSize: 11, color: "#555", width: 80, textAlign: "right", flexShrink: 0 }}>
                {c.health.daysSince !== null ? `${c.health.daysSince}d ago` : "Never"}
              </div>
            </div>
          ))}
          {contacts.length === 0 && <div style={{ color: "#555", fontSize: 13, fontStyle: "italic" }}>Add contacts to see health scores.</div>}
        </div>
      </div>

      {/* Three AI panels */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16 }}>

        {/* Next best actions */}
        <div style={{ background: "#0d0d14", border: "1px solid #1a1a2a", borderRadius: 12, padding: 20 }}>
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontWeight: 700, color: "#f0f0ff", fontFamily: "'Syne', sans-serif", fontSize: 14, marginBottom: 4 }}>✦ Next Best Actions</div>
            <div style={{ fontSize: 11, color: "#666" }}>AI-suggested outreach priorities</div>
          </div>
          {!nextActions && <Btn size="sm" onClick={getNextActions} disabled={loadingActions || contacts.length === 0}>{loadingActions ? "✦ Thinking…" : "✦ Generate"}</Btn>}
          {nextActions && (
            <div style={{ display: "grid", gap: 10 }}>
              {nextActions.slice(0, 5).map((a, i) => (
                <div key={i} style={{ background: "#080810", borderRadius: 8, padding: "10px 12px", border: `1px solid ${PRIORITY_COLORS[a.priority]}30` }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                    <span style={{ fontSize: 10, fontWeight: 700, color: PRIORITY_COLORS[a.priority], textTransform: "uppercase" }}>{a.priority}</span>
                    <span style={{ fontSize: 12, fontWeight: 700, color: "#f0f0ff" }}>{a.contactName}</span>
                  </div>
                  <div style={{ fontSize: 12, color: "#ccc", marginBottom: 3 }}>{a.action}</div>
                  <div style={{ fontSize: 11, color: "#555", fontStyle: "italic" }}>{a.reason}</div>
                </div>
              ))}
              <Btn size="sm" variant="ghost" onClick={getNextActions} disabled={loadingActions}>{loadingActions ? "Refreshing…" : "↺ Refresh"}</Btn>
            </div>
          )}
        </div>

        {/* Email triage */}
        <div style={{ background: "#0d0d14", border: "1px solid #1a1a2a", borderRadius: 12, padding: 20 }}>
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontWeight: 700, color: "#f0f0ff", fontFamily: "'Syne', sans-serif", fontSize: 14, marginBottom: 4 }}>📬 Email Triage</div>
            <div style={{ fontSize: 11, color: "#666" }}>Sort what needs attention</div>
          </div>
          {!triageResults && <Btn size="sm" onClick={triageEmails} disabled={loadingTriage || emails.length === 0}>{loadingTriage ? "✦ Sorting…" : "✦ Triage Emails"}</Btn>}
          {triageResults && (
            <div style={{ display: "grid", gap: 12 }}>
              {[
                { key: "urgent", label: "🔴 Urgent", color: "#ef4444" },
                { key: "later", label: "🟡 Later", color: "#f59e0b" },
                { key: "trash", label: "⚫ Trash", color: "#6b7280" },
              ].map(cat => (
                <div key={cat.key}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: cat.color, marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.06em" }}>{cat.label} ({triageResults[cat.key]?.length || 0})</div>
                  {(triageResults[cat.key] || []).slice(0, 3).map((e, i) => {
                    const contact = contacts.find(c => c.id === e.contactId);
                    return <div key={i} style={{ fontSize: 11, color: "#888", padding: "4px 0", borderBottom: "1px solid #1a1a2a" }}>{contact?.name || "?"} — {e.subject?.slice(0, 30)}{e.subject?.length > 30 ? "…" : ""}</div>;
                  })}
                  {(triageResults[cat.key] || []).length === 0 && <div style={{ fontSize: 11, color: "#444", fontStyle: "italic" }}>None</div>}
                </div>
              ))}
              <Btn size="sm" variant="ghost" onClick={triageEmails} disabled={loadingTriage}>{loadingTriage ? "Re-sorting…" : "↺ Re-triage"}</Btn>
            </div>
          )}
        </div>

        {/* Sentiment analysis */}
        <div style={{ background: "#0d0d14", border: "1px solid #1a1a2a", borderRadius: 12, padding: 20 }}>
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontWeight: 700, color: "#f0f0ff", fontFamily: "'Syne', sans-serif", fontSize: 14, marginBottom: 4 }}>💬 Sentiment Tracker</div>
            <div style={{ fontSize: 11, color: "#666" }}>Relationship temperature</div>
          </div>
          {!sentimentResults && <Btn size="sm" onClick={analyzeSentiment} disabled={loadingSentiment || emails.length === 0}>{loadingSentiment ? "✦ Analyzing…" : "✦ Analyze"}</Btn>}
          {sentimentResults && (
            <div style={{ display: "grid", gap: 10 }}>
              {sentimentResults.slice(0, 6).map((s, i) => {
                const SENT_COLORS = { Warming: "#10b981", Neutral: "#3b82f6", Cooling: "#f59e0b", Cold: "#ef4444" };
                const TREND_ICONS = { up: "↑", flat: "→", down: "↓" };
                const color = SENT_COLORS[s.sentiment] || "#888";
                return (
                  <div key={i} style={{ background: "#080810", borderRadius: 8, padding: "8px 10px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
                      <span style={{ fontSize: 12, fontWeight: 700, color: "#f0f0ff" }}>{s.contactName}</span>
                      <span style={{ fontSize: 10, fontWeight: 700, color, marginLeft: "auto" }}>{s.sentiment} {TREND_ICONS[s.trend]}</span>
                    </div>
                    <div style={{ fontSize: 11, color: "#666", fontStyle: "italic" }}>{s.insight}</div>
                  </div>
                );
              })}
              <Btn size="sm" variant="ghost" onClick={analyzeSentiment} disabled={loadingSentiment}>{loadingSentiment ? "Re-analyzing…" : "↺ Refresh"}</Btn>
            </div>
          )}
        </div>
      </div>

      {/* Upcoming meetings */}
      {upcomingMeetings.length > 0 && (
        <div style={{ background: "#0d0d14", border: "1px solid #1a1a2a", borderRadius: 12, padding: 20 }}>
          <div style={{ fontWeight: 700, color: "#f0f0ff", fontFamily: "'Syne', sans-serif", marginBottom: 14 }}>📅 Upcoming Meetings</div>
          <div style={{ display: "grid", gap: 10 }}>
            {upcomingMeetings.map(m => {
              const contact = contacts.find(c => c.id === m.contactId);
              return (
                <div key={m.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 14px", background: "#080810", borderRadius: 8 }}>
                  {contact && <Avatar name={contact.name} size={32} />}
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: "#f0f0ff" }}>{m.title}</div>
                    <div style={{ fontSize: 11, color: "#666" }}>{contact?.name} · {m.date} · {m.time}</div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Cold contacts alert */}
      {coldContacts.length > 0 && (
        <div style={{ background: "#ef444410", border: "1px solid #ef444430", borderRadius: 12, padding: 20 }}>
          <div style={{ fontWeight: 700, color: "#ef4444", fontFamily: "'Syne', sans-serif", marginBottom: 12, fontSize: 14 }}>⚠ Relationships Going Cold ({coldContacts.length})</div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            {coldContacts.slice(0, 6).map(c => (
              <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 8, background: "#080810", borderRadius: 8, padding: "8px 12px", border: "1px solid #ef444420" }}>
                <Avatar name={c.name || "?"} size={24} />
                <div>
                  <div style={{ fontSize: 12, fontWeight: 700, color: "#f0f0ff" }}>{c.name}</div>
                  <div style={{ fontSize: 10, color: "#ef4444" }}>{c.health.daysSince !== null ? `${c.health.daysSince}d since contact` : "Never contacted"}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── CSV IMPORT ───────────────────────────────────────────────────────────────
function CSVImportModal({ onClose, contactsCol }) {
  const [preview, setPreview] = useState(null);
  const [mapping, setMapping] = useState({});
  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState(0);
  const [done, setDone] = useState(false);
  const fileRef = useRef();

  function parseCSV(text) {
    // Normalize line endings
    const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const isTab = normalized.split("\n")[0].includes("\t");
    const delimiter = isTab ? "\t" : ",";

    // For tab-delimited: handle multi-line quoted fields by reassembling
    function parseAllRows(raw) {
      const result = [];
      let current = "";
      let inQuote = false;
      for (let i = 0; i < raw.length; i++) {
        const ch = raw[i];
        if (ch === '"') {
          inQuote = !inQuote;
          current += ch;
        } else if (ch === "\n" && !inQuote) {
          result.push(current);
          current = "";
        } else {
          current += ch;
        }
      }
      if (current.trim()) result.push(current);
      return result;
    }

    function splitRow(line) {
      const fields = [];
      let cur = "";
      let inQ = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
          if (inQ && line[i+1] === '"') { cur += '"'; i++; }
          else inQ = !inQ;
        } else if (ch === delimiter && !inQ) {
          fields.push(cur.replace(/#REF!/g,"").replace(/#N\/A/g,"").replace(/#VALUE!/g,"").trim());
          cur = "";
        } else {
          cur += ch;
        }
      }
      fields.push(cur.replace(/#REF!/g,"").replace(/#N\/A/g,"").replace(/#VALUE!/g,"").trim());
      return fields;
    }

    const allRows = parseAllRows(normalized);
    const rawHeaders = splitRow(allRows[0]);

    // Deduplicate headers
    const headerCount = {};
    const headers = rawHeaders.map(h => {
      const key = h.trim();
      if (!key) return null;
      if (headerCount[key] !== undefined) { headerCount[key]++; return `${key}_${headerCount[key]}`; }
      headerCount[key] = 0;
      return key;
    });

    const rows = allRows.slice(1).map(line => {
      if (!line.trim()) return null;
      const vals = splitRow(line);
      const row = {};
      headers.forEach((h, i) => { if (h) row[h] = (vals[i] || "").trim(); });
      return row;
    }).filter(row => {
      if (!row) return false;
      const meaningful = ["First Name","Last Name","Full Name","Primary Email","Company Name"];
      return meaningful.some(f => row[f] && row[f].trim());
    });

    return { headers: headers.filter(Boolean), rows };
  }

  const IMPORT_FIELDS = [
    { key: "firstName", label: "First Name" }, { key: "middleName", label: "Middle Name" },
    { key: "lastName", label: "Last Name" }, { key: "suffix", label: "Suffix" },
    { key: "company", label: "Company Name" }, { key: "email", label: "Primary Email" },
    { key: "phone", label: "Primary Phone" }, { key: "street1", label: "Street 1" },
    { key: "street2", label: "Street 2" }, { key: "city", label: "City" },
    { key: "state", label: "State" }, { key: "zip", label: "Zip" },
    { key: "country", label: "Country" }, { key: "website", label: "Website" },
    { key: "jobTitle", label: "Job Title" }, { key: "birthday", label: "Birthday" },
    { key: "backgroundInfo", label: "Background Info" }, { key: "industry", label: "Industry" },
    { key: "investments", label: "Investments" }, { key: "linkedIn", label: "LinkedIn" },
    { key: "school", label: "School" }, { key: "connectedVia", label: "Connected / Introduced By" },
    { key: "platformDescription", label: "Platform Description" }, { key: "researchTeam", label: "Research Team" },
    { key: "metroArea", label: "Metro Area" }, { key: "bd", label: "B/D" },
    { key: "importGroups", label: "Groups (from import)" }, { key: "notes", label: "Notes" },
    { key: "status", label: "Status" },
  ];

  function handleFile(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onerror = () => alert("Error reading file. Please try again.");
    reader.onload = ev => {
      try {
        const { headers, rows } = parseCSV(ev.target.result);
      const autoMap = {};
      headers.forEach(h => {
        const lower = h.toLowerCase().replace(/[\s_\-]/g, "");
        const orig = h.trim();
        if (orig === "First Name") autoMap.firstName = h;
        else if (lower === "firstname" || lower === "first") autoMap.firstName = h;
        if (orig === "Middle Name") autoMap.middleName = h;
        else if (lower === "middlename" || lower === "middle") autoMap.middleName = h;
        if (orig === "Last Name") autoMap.lastName = h;
        else if (lower === "lastname" || lower === "last") autoMap.lastName = h;
        if (orig === "Suffix" || lower === "suffix") autoMap.suffix = h;
        if (orig === "Full Name") autoMap.name = h;
        if (orig === "Company Name" || lower === "company" || lower.includes("organization")) autoMap.company = h;
        if (orig === "Primary Email" || lower === "email" || lower.includes("emailaddress")) autoMap.email = h;
        if (orig === "Primary Phone" || lower === "phone" || lower.includes("mobile")) autoMap.phone = h;
        if (orig === "Primary Street 1" || lower.includes("street1") || lower.includes("primarystreet1")) autoMap.street1 = h;
        if (orig === "Primary Street 2" || lower.includes("street2") || lower.includes("primarystreet2")) autoMap.street2 = h;
        if (orig === "Primary City" || lower === "primarycity" || lower === "city") autoMap.city = h;
        if (orig === "Primary State" || lower === "primarystate" || lower === "state") autoMap.state = h;
        if (orig === "Primary Zip" || lower === "primaryzip" || lower === "zip" || lower.includes("postal")) autoMap.zip = h;
        if (orig === "Primary Country" || lower === "primarycountry" || lower === "country") autoMap.country = h;
        if (orig === "Primary Address") autoMap.fullAddress = h;
        if (orig === "Website" || lower.includes("website") || lower.includes("url")) autoMap.website = h;
        if (orig === "Job Title" || lower.includes("jobtitle") || lower === "title" || lower.includes("position")) autoMap.jobTitle = h;
        if (orig === "Birthday" || lower.includes("birthday") || lower.includes("birthdate")) autoMap.birthday = h;
        if (orig === "Background Info" || lower.includes("background") || lower.includes("bio")) autoMap.backgroundInfo = h;
        if (orig === "Industry" && !autoMap.industry) autoMap.industry = h;
        if (orig === "Investments" && !autoMap.investments) autoMap.investments = h;
        if (orig === "LinkedIn Contacts" || lower.includes("linkedin")) autoMap.linkedIn = h;
        if (orig === "School" || lower.includes("school") || lower.includes("university")) autoMap.school = h;
        if (orig === "Connected/Introduced" || lower.includes("connected") || lower.includes("introduced")) autoMap.connectedVia = h;
        if (orig === "Platform Desciption" || lower.includes("platform")) autoMap.platformDescription = h;
        if (orig === "Research Team" || lower.includes("research")) autoMap.researchTeam = h;
        if (orig === "Metro Area" || lower.includes("metro")) autoMap.metroArea = h;
        if (orig === "B/D" || lower === "bd" || lower.includes("b/d")) autoMap.bd = h;
        if (orig === "Groups - from import") autoMap.importGroups = h;
        else if (orig === "Groups" || lower === "groups") autoMap.importGroups = h;
        if (orig === "Notes" || lower === "notes") autoMap.notes = h;
        if (orig === "Status" || lower === "status") autoMap.status = h;
        if (orig === "All Email" || lower === "allemail") autoMap.allEmail = h;
        if (orig === "All Phone" || lower === "allphone") autoMap.allPhone = h;
        if (orig === "All Addresses" || lower === "alladdresses") autoMap.allAddresses = h;
        if (orig === "Primary Type" || lower === "primarytype") autoMap.primaryType = h;
        if (orig === "Company Street" || lower === "companystreet") autoMap.companyStreet = h;
        if (orig === "Company City" || lower === "companycity") autoMap.companyCity = h;
        if (orig === "Company State" || lower === "companystate") autoMap.companyState = h;
        if (orig === "Company Zip" || lower === "companyzip") autoMap.companyZip = h;
        if (orig === "Company Country" || lower === "companycountry") autoMap.companyCountry = h;
        if (orig === "Creation Date" || lower === "creationdate") autoMap.creationDate = h;
        if (orig === "Last Edited Date" || lower === "lastediteddate") autoMap.lastEditedDate = h;
        if (orig === "Assigned To" || lower === "assignedto") autoMap.assignedTo = h;
        if (orig === "Consultants" || lower === "consultants") autoMap.consultants = h;
        if (orig === "Relationships" || lower === "relationships") autoMap.relationships = h;
        if (orig === "Address 1 Street" || lower === "address1street" || lower === "addr1street") autoMap.addr1Street = h;
        if (orig === "Address 1 City" || lower === "address1city" || lower === "addr1city") autoMap.addr1City = h;
        if (orig === "Address 1 State" || lower === "address1state" || lower === "addr1state") autoMap.addr1State = h;
        if (orig === "Address 1 Zip" || lower === "address1zip" || lower === "addr1zip") autoMap.addr1Zip = h;
        if (orig === "Address 1 Country" || lower === "address1country" || lower === "addr1country") autoMap.addr1Country = h;
        if (orig === "Address 1 Type" || lower === "address1type" || lower === "addr1type") autoMap.addr1Type = h;
        if (orig === "Address 2 Street" || lower === "address2street" || lower === "addr2street") autoMap.addr2Street = h;
        if (orig === "Address 2 City" || lower === "address2city" || lower === "addr2city") autoMap.addr2City = h;
        if (orig === "Address 2 State" || lower === "address2state" || lower === "addr2state") autoMap.addr2State = h;
        if (orig === "Address 2 Zip" || lower === "address2zip" || lower === "addr2zip") autoMap.addr2Zip = h;
        if (orig === "Address 2 Country" || lower === "address2country" || lower === "addr2country") autoMap.addr2Country = h;
        if (orig === "Address 2 Type" || lower === "address2type" || lower === "addr2type") autoMap.addr2Type = h;
      });
        setPreview({ headers, rows: rows.slice(0, 3), allRows: rows });
        setMapping(autoMap);
      } catch(err) {
        alert("Failed to parse file: " + err.message + "\n\nTry saving your Excel file as CSV UTF-8 format.");
        console.error("Parse error:", err);
      }
    };
    reader.readAsText(file, "UTF-8");
  }

  async function doImport() {
    setImporting(true);
    setImportProgress(0);
    const BATCH_SIZE = 5;
    const rows = preview.allRows;
    let imported = 0;
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      await Promise.all(batch.map(async row => {
        const firstName = row[mapping.firstName] || "";
        const middleName = row[mapping.middleName] || "";
        const lastName = row[mapping.lastName] || "";
        const suffix = row[mapping.suffix] || "";
        const displayName = [firstName, middleName, lastName, suffix].filter(Boolean).join(" ");
        const city = row[mapping.city] || "";
        const contact = {
          name: displayName,
          firstName, middleName, lastName, suffix,
          email: row[mapping.email] || row[mapping.allEmail] || "",
          allEmail: row[mapping.allEmail] || "",
          company: row[mapping.company] || "",
          phone: row[mapping.phone] || row[mapping.allPhone] || "",
          allPhone: row[mapping.allPhone] || "",
          primaryStreet1: row[mapping.street1] || "",
          primaryStreet2: row[mapping.street2] || "",
          primaryCity: city,
          primaryState: row[mapping.state] || "",
          primaryZip: row[mapping.zip] || "",
          primaryCountry: row[mapping.country] || "",
          primaryType: row[mapping.primaryType] || "",
          companyStreet: row[mapping.companyStreet] || "",
          companyCity: row[mapping.companyCity] || "",
          companyState: row[mapping.companyState] || "",
          companyZip: row[mapping.companyZip] || "",
          companyCountry: row[mapping.companyCountry] || "",
          allAddresses: row[mapping.allAddresses] || "",
          addr1Street: row[mapping.addr1Street] || "",
          addr1City: row[mapping.addr1City] || "",
          addr1State: row[mapping.addr1State] || "",
          addr1Zip: row[mapping.addr1Zip] || "",
          addr1Country: row[mapping.addr1Country] || "",
          addr1Type: row[mapping.addr1Type] || "",
          addr2Street: row[mapping.addr2Street] || "",
          addr2City: row[mapping.addr2City] || "",
          addr2State: row[mapping.addr2State] || "",
          addr2Zip: row[mapping.addr2Zip] || "",
          addr2Country: row[mapping.addr2Country] || "",
          addr2Type: row[mapping.addr2Type] || "",
          website: row[mapping.website] || "",
          jobTitle: row[mapping.jobTitle] || "",
          birthday: row[mapping.birthday] || "",
          backgroundInfo: row[mapping.backgroundInfo] || "",
          creationDate: row[mapping.creationDate] || "",
          lastEditedDate: row[mapping.lastEditedDate] || "",
          assignedTo: row[mapping.assignedTo] || "",
          industry: row[mapping.industry] || "",
          investments: row[mapping.investments] || "",
          linkedIn: row[mapping.linkedIn] || "",
          school: row[mapping.school] || "",
          connectedVia: row[mapping.connectedVia] || "",
          platformDescription: row[mapping.platformDescription] || "",
          researchTeam: row[mapping.researchTeam] || "",
          metroArea: row[mapping.metroArea] || city || "",
          bd: row[mapping.bd] || "",
          consultants: row[mapping.consultants] || "",
          importGroups: row[mapping.importGroups] || "",
          relationships: row[mapping.relationships] || "",
          notes: row[mapping.notes] || "",
          status: row[mapping.status] || "prospect",
          tags: [],
          importedAt: new Date().toISOString(),
        };
        if (contact.name || contact.email) await contactsCol.add(contact);
      }));
      imported += batch.length;
      setImportProgress(Math.round((imported / rows.length) * 100));
      await new Promise(r => setTimeout(r, 500));
    }
    setImporting(false);
    setDone(true);
    if (fileRef.current) fileRef.current.value = "";
  }

  return (
    <Modal title="Import Contacts from CSV" onClose={onClose} wide>
      {!preview ? (
        <div>
          <p style={{ color: "#888", fontSize: 13, marginBottom: 20, lineHeight: 1.6 }}>Export contacts from HubSpot, Salesforce, Excel, or Google Contacts as CSV, then upload here.</p>
          <div style={{ border: "2px dashed #2a2a3a", borderRadius: 12, padding: "40px", textAlign: "center", cursor: "pointer" }} onClick={() => { if (fileRef.current) { fileRef.current.value = ""; fileRef.current.click(); } }}>
            <div style={{ fontSize: 32, marginBottom: 8 }}>📁</div>
            <div style={{ color: "#888", fontSize: 13 }}>Click to upload CSV file</div>
            <input ref={fileRef} type="file" accept=".csv" style={{ display: "none" }} onChange={handleFile} />
          </div>
        </div>
      ) : done ? (
        <div style={{ textAlign: "center", padding: "40px 0" }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>🎉</div>
          <div style={{ fontSize: 18, fontWeight: 700, color: "#f0f0ff", marginBottom: 8 }}>Import Complete!</div>
          <div style={{ color: "#888", fontSize: 13, marginBottom: 24 }}>{preview.allRows.length} contacts imported.</div>
          <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
            <Btn variant="ghost" onClick={() => { setDone(false); setPreview(null); setMapping({}); if (fileRef.current) fileRef.current.value = ""; }}>Import Another File</Btn>
            <Btn onClick={onClose}>Done</Btn>
          </div>
        </div>
      ) : (
        <div>
          <p style={{ color: "#888", fontSize: 13, marginBottom: 16 }}>Found {preview.allRows.length} contacts. Map your columns:</p>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 20 }}>
            {IMPORT_FIELDS.map(field => (
              <div key={field.key}>
                <label style={{ display: "block", marginBottom: 4, fontSize: 11, fontWeight: 700, color: "#888", textTransform: "uppercase", letterSpacing: "0.06em" }}>{field.label}</label>
                <select value={mapping[field.key] || ""} onChange={e => setMapping(m => ({ ...m, [field.key]: e.target.value }))} style={{ width: "100%", background: "#0d0d14", border: "1px solid #2a2a3a", borderRadius: 8, padding: "8px 12px", color: "#e0e0ff", fontSize: 13, fontFamily: "inherit", outline: "none" }}>
                  <option value="">-- skip --</option>
                  {preview.headers.map(h => <option key={h} value={h}>{h}</option>)}
                </select>
              </div>
            ))}
          </div>
          {importing && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 12, color: "#888", marginBottom: 8 }}>Importing… {importProgress}% ({Math.round(preview.allRows.length * importProgress / 100)} of {preview.allRows.length})</div>
              <div style={{ height: 6, background: "#1e1e2e", borderRadius: 10, overflow: "hidden" }}>
                <div style={{ width: `${importProgress}%`, height: "100%", background: "#6366f1", borderRadius: 10, transition: "width 0.3s ease" }} />
              </div>
            </div>
          )}
          <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
            <Btn variant="ghost" onClick={onClose} disabled={importing}>Cancel</Btn>
            <Btn onClick={doImport} disabled={importing || !mapping.name}>{importing ? `Importing ${importProgress}%…` : `Import ${preview.allRows.length} Contacts`}</Btn>
          </div>
        </div>
      )}
    </Modal>
  );
}

// ─── CONTACT DETAIL MODAL ────────────────────────────────────────────────────
function ContactDetailModal({ contact, onClose, onEdit, emails, meetings }) {
  const cEmails = emails.filter(e => e.contactId === contact.id).sort((a,b) => (b.date||"").localeCompare(a.date||""));
  const cMeetings = meetings.filter(m => m.contactId === contact.id).sort((a,b) => (b.date||"").localeCompare(a.date||""));
  const Row = ({ label, value }) => value ? (
    <div style={{ display: "flex", gap: 12, padding: "8px 0", borderBottom: "1px solid #1a1a2a" }}>
      <div style={{ width: 140, fontSize: 11, fontWeight: 700, color: "#666", textTransform: "uppercase", letterSpacing: "0.06em", flexShrink: 0 }}>{label}</div>
      <div style={{ fontSize: 13, color: "#ccc", wordBreak: "break-word" }}>{value}</div>
    </div>
  ) : null;
  return (
    <Modal title={contact.name || "Contact"} onClose={onClose} wide>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24 }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 20 }}>
            <Avatar name={contact.name || "?"} size={56} />
            <div>
              <div style={{ fontSize: 20, fontWeight: 800, color: "#f0f0ff", fontFamily: "'Syne', sans-serif" }}>{contact.name}</div>
              <div style={{ fontSize: 13, color: "#888" }}>{contact.jobTitle}{contact.jobTitle && contact.company ? " · " : ""}{contact.company}</div>
              <StatusBadge status={contact.status} />
            </div>
          </div>
          <Row label="First Name" value={contact.firstName} />
          <Row label="Middle Name" value={contact.middleName} />
          <Row label="Last Name" value={contact.lastName} />
          <Row label="Suffix" value={contact.suffix} />
          <Row label="Email" value={contact.email} />
          <Row label="Phone" value={contact.phone} />
          <Row label="Company" value={contact.company} />
          <Row label="Job Title" value={contact.jobTitle} />
          <Row label="Industry" value={contact.industry} />
          <Row label="Metro Area" value={contact.metroArea} />
          <Row label="City" value={contact.primaryCity} />
          <Row label="State" value={contact.primaryState} />
          <Row label="Zip" value={contact.primaryZip} />
          <Row label="Country" value={contact.primaryCountry} />
          <Row label="Street 1" value={contact.primaryStreet1} />
          <Row label="Street 2" value={contact.primaryStreet2} />
          <Row label="Website" value={contact.website} />
          <Row label="LinkedIn" value={contact.linkedIn} />
          <Row label="Birthday" value={contact.birthday} />
          <Row label="School" value={contact.school} />
          <Row label="B/D" value={contact.bd} />
          <Row label="Investments" value={contact.investments} />
          <Row label="Research Team" value={contact.researchTeam} />
          <Row label="Connected Via" value={contact.connectedVia} />
          <Row label="Groups" value={contact.importGroups} />
          <Row label="Relationships" value={contact.relationships} />
          <Row label="Consultants" value={contact.consultants} />
          <Row label="Platform" value={contact.platformDescription} />
          <Row label="All Email" value={contact.allEmail} />
          <Row label="All Phone" value={contact.allPhone} />
          <Row label="Company Street" value={contact.companyStreet} />
          <Row label="Company City" value={contact.companyCity} />
          <Row label="Assigned To" value={contact.assignedTo} />
          <Row label="Background" value={contact.backgroundInfo} />
          <Row label="Notes" value={contact.notes} />
        </div>
        <div>
          <div style={{ fontWeight: 700, color: "#9999cc", fontSize: 12, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 12 }}>Recent Emails ({cEmails.length})</div>
          <div style={{ display: "grid", gap: 8, marginBottom: 24 }}>
            {cEmails.slice(0,5).map(e => (
              <div key={e.id} style={{ background: "#080810", borderRadius: 8, padding: "8px 12px" }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: "#f0f0ff" }}>{e.subject}</div>
                <div style={{ fontSize: 11, color: "#555" }}>{e.direction} · {e.date}</div>
              </div>
            ))}
            {cEmails.length === 0 && <div style={{ fontSize: 12, color: "#444", fontStyle: "italic" }}>No emails yet</div>}
          </div>
          <div style={{ fontWeight: 700, color: "#9999cc", fontSize: 12, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 12 }}>Meetings ({cMeetings.length})</div>
          <div style={{ display: "grid", gap: 8 }}>
            {cMeetings.slice(0,5).map(m => (
              <div key={m.id} style={{ background: "#080810", borderRadius: 8, padding: "8px 12px" }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: "#f0f0ff" }}>{m.title}</div>
                <div style={{ fontSize: 11, color: "#555" }}>{m.date} · {m.time}</div>
              </div>
            ))}
            {cMeetings.length === 0 && <div style={{ fontSize: 12, color: "#444", fontStyle: "italic" }}>No meetings yet</div>}
          </div>
        </div>
      </div>
      <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 24 }}>
        <Btn variant="ghost" onClick={onClose}>Close</Btn>
        <Btn onClick={() => { onClose(); onEdit(contact); }}>Edit Contact</Btn>
      </div>
    </Modal>
  );
}

// ─── CONTACTS TAB ─────────────────────────────────────────────────────────────
function ContactsTab({ contactsCol, emails, meetings, groups }) {
  const { docs: contacts, loading: contactsLoading, totalCount, totalPages, page, nextPage, prevPage, doSearch, search } = contactsCol;
  const [searchInput, setSearchInput] = useState("");
  const [filter, setFilter] = useState("all");
  const [groupFilter, setGroupFilter] = useState("all");
  const [importGroupFilter, setImportGroupFilter] = useState("all");
  const [showModal, setShowModal] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showDetail, setShowDetail] = useState(null);
  const [editing, setEditing] = useState(null);
  const blank = { name: "", firstName: "", middleName: "", lastName: "", suffix: "", company: "", email: "", phone: "", jobTitle: "", metroArea: "", primaryStreet1: "", primaryStreet2: "", primaryCity: "", primaryState: "", primaryZip: "", primaryCountry: "", website: "", birthday: "", school: "", backgroundInfo: "", industry: "", investments: "", linkedIn: "", connectedVia: "", platformDescription: "", researchTeam: "", bd: "", status: "prospect", tags: "", notes: "" };
  const [form, setForm] = useState(blank);

  function handleSearchChange(val) {
    setSearchInput(val);
    doSearch(val);
  }

  // Build display name from parts if name field is empty
  const contactsWithNames = contacts.map(c => ({
    ...c,
    name: c.name || [c.firstName, c.middleName, c.lastName, c.suffix].filter(Boolean).join(" ") || c.company || "Unknown"
  }));

  // Client-side filter on top of server-paginated results
  const filtered = contactsWithNames.filter(c => {
    // Hide company-only entries (no personal name) from contacts page
    const hasPersonalName = c.firstName || c.lastName || (c.name && c.name !== c.company);
    if (!hasPersonalName) return false;
    const matchFilter = filter === "all" || c.status === filter;
    const matchGroup = groupFilter === "all" || (c.groups || []).includes(groupFilter);
    const matchImportGroup = importGroupFilter === "all" || c.importGroups === importGroupFilter;
    return matchFilter && matchGroup && matchImportGroup;
  });

  // Import groups from current page only
  const importGroups = [...new Set(contacts.map(c => c.importGroups).filter(Boolean))].sort();

  function openNew() { setForm(blank); setEditing(null); setShowModal(true); }
  function openEdit(c) { setForm({ ...c, tags: (c.tags || []).join(", ") }); setEditing(c); setShowModal(true); }

  async function save() {
    const data = { ...form, tags: form.tags.split(",").map(t => t.trim()).filter(Boolean) };
    if (editing) await contactsCol.update(editing.id, data);
    else await contactsCol.add(data);
    setShowModal(false);
  }

  async function deleteContact(c) {
    if (!window.confirm(`Delete ${c.name}? This cannot be undone.`)) return;
    await contactsCol.remove(c.id);
  }

  return (
    <div>
      <div style={{ display: "flex", gap: 12, marginBottom: 20, flexWrap: "wrap" }}>
        <input value={searchInput} onChange={e => handleSearchChange(e.target.value)} placeholder="Search contacts…" style={{ flex: 1, minWidth: 180, background: "#0d0d14", border: "1px solid #2a2a3a", borderRadius: 8, padding: "10px 14px", color: "#e0e0ff", fontSize: 14, fontFamily: "inherit", outline: "none" }} />
        <select value={filter} onChange={e => setFilter(e.target.value)} style={{ background: "#0d0d14", border: "1px solid #2a2a3a", borderRadius: 8, padding: "10px 14px", color: "#e0e0ff", fontSize: 14, fontFamily: "inherit", outline: "none" }}>
          {["all","prospect","active","customer","inactive"].map(s => <option key={s} value={s}>{s === "all" ? "All Statuses" : s.charAt(0).toUpperCase() + s.slice(1)}</option>)}
        </select>
        <select value={groupFilter} onChange={e => setGroupFilter(e.target.value)} style={{ background: "#0d0d14", border: "1px solid #2a2a3a", borderRadius: 8, padding: "10px 14px", color: "#e0e0ff", fontSize: 14, fontFamily: "inherit", outline: "none" }}>
          <option value="all">All Groups</option>
          {groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
        </select>
        <Btn variant="ghost" onClick={() => setShowImport(true)}>⬆ Import CSV</Btn>
        <Btn onClick={openNew}>+ New Contact</Btn>
        {contacts.some(c => c.importedAt && new Date(c.importedAt) > new Date(Date.now() - 60*60*1000)) && (
          <Btn variant="yellow" onClick={async () => {
            const recent = contacts.filter(c => c.importedAt && new Date(c.importedAt) > new Date(Date.now() - 60*60*1000));
            if (!window.confirm(`Undo last import? This will delete ${recent.length} contacts imported in the last hour.`)) return;
            const BATCH = 50;
            for (let i = 0; i < recent.length; i += BATCH) {
              await Promise.all(recent.slice(i, i + BATCH).map(c => contactsCol.remove(c.id)));
              await new Promise(r => setTimeout(r, 200));
            }
          }}>↩ Undo Last Import</Btn>
        )}
        <div style={{ fontSize: 11, color: "#555", alignSelf: "center" }}>Double-click a contact to open</div>
      </div>
      {/* Page info + filter bar */}
      <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
        <span style={{ fontSize: 12, color: "#555" }}>
          {search ? `${filtered.length} results` : `${totalCount.toLocaleString()} total · page ${page + 1} of ${totalPages || 1}`}
        </span>
        {importGroups.length > 0 && (
          <select value={importGroupFilter} onChange={e => setImportGroupFilter(e.target.value)} style={{ background: "#0d0d14", border: "1px solid #2a2a3a", borderRadius: 8, padding: "4px 10px", color: "#e0e0ff", fontSize: 12, fontFamily: "inherit", outline: "none" }}>
            <option value="all">All Import Groups</option>
            {importGroups.map(g => <option key={g} value={g}>{g}</option>)}
          </select>
        )}
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <button onClick={prevPage} disabled={page === 0} style={{ padding: "4px 14px", borderRadius: 8, border: "1px solid #2a2a3a", background: "transparent", color: page === 0 ? "#333" : "#9999cc", cursor: page === 0 ? "not-allowed" : "pointer", fontSize: 12 }}>← Prev</button>
          <button onClick={nextPage} disabled={page >= totalPages - 1 || contacts.length < PAGE_SIZE} style={{ padding: "4px 14px", borderRadius: 8, border: "1px solid #2a2a3a", background: "transparent", color: (page >= totalPages - 1 || contacts.length < PAGE_SIZE) ? "#333" : "#9999cc", cursor: (page >= totalPages - 1 || contacts.length < PAGE_SIZE) ? "not-allowed" : "pointer", fontSize: 12 }}>Next →</button>
        </div>
      </div>

      <div style={{ display: "grid", gap: 10 }}>
        {filtered.map(c => {
          const health = calcHealthScore(c, emails, meetings);
          const cEmails = emails.filter(e => e.contactId === c.id).length;
          const cMeetings = meetings.filter(m => m.contactId === c.id).length;
          const cGroups = groups.filter(g => (c.groups || []).includes(g.id));
          return (
            <div key={c.id} style={{ background: "#0d0d14", border: "1px solid #1e1e2e", borderRadius: 12, padding: "14px 20px", display: "flex", alignItems: "center", gap: 16, transition: "border-color 0.15s", cursor: "pointer" }}
              onMouseEnter={e => e.currentTarget.style.borderColor = "#6366f1"}
              onMouseLeave={e => e.currentTarget.style.borderColor = "#1e1e2e"}
              onDoubleClick={() => setShowDetail(c)}>
              <Avatar name={c.name || "?"} size={40} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 3, flexWrap: "wrap" }}>
                  <span style={{ fontWeight: 700, fontSize: 14, color: "#f0f0ff", fontFamily: "'Syne', sans-serif" }}>{c.lastName ? `${c.lastName}, ${c.firstName || ""}${c.middleName ? " " + c.middleName : ""}` : c.name || c.company}</span>
                  <StatusBadge status={c.status} />
                  {cGroups.map(g => <Tag key={g.id} color={g.color || "#6366f1"}>{g.name}</Tag>)}
                  {c.importGroups && <Tag color="#8b5cf6">{c.importGroups}</Tag>}
                </div>
                <div style={{ fontSize: 12, color: "#888", marginBottom: 6 }}>{c.jobTitle ? `${c.jobTitle} · ` : ""}{c.company}{c.primaryCity ? ` · ${c.primaryCity}` : c.metroArea ? ` · ${c.metroArea}` : ""}{c.industry ? ` · ${c.industry}` : ""}</div>
                <HealthBar score={health.score} color={health.color} label={health.label} size="sm" />
              </div>
              <div style={{ display: "flex", gap: 16, color: "#666", fontSize: 11, textAlign: "center" }}>
                <div><div style={{ fontSize: 16, fontWeight: 700, color: "#9999cc" }}>{cEmails}</div>emails</div>
                <div><div style={{ fontSize: 16, fontWeight: 700, color: "#9999cc" }}>{cMeetings}</div>mtgs</div>
              </div>
              <div style={{ display: "flex", gap: 8 }} onClick={e => e.stopPropagation()}>
                <Btn size="sm" variant="ghost" onClick={() => openEdit(c)}>Edit</Btn>
                <Btn size="sm" variant="danger" onClick={() => deleteContact(c)}>×</Btn>
              </div>
            </div>
          );
        })}
        {filtered.length === 0 && <div style={{ textAlign: "center", color: "#555", padding: "60px 0", fontStyle: "italic" }}>No contacts found.</div>}
      </div>
      {showDetail && <ContactDetailModal contact={showDetail} onClose={() => setShowDetail(null)} onEdit={openEdit} emails={emails} meetings={meetings} />}
      {showImport && <CSVImportModal onClose={() => setShowImport(false)} contactsCol={contactsCol} />}
      {showModal && (
        <Modal title={editing ? "Edit Contact" : "New Contact"} onClose={() => setShowModal(false)}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
            <Field label="First Name" value={form.firstName || ""} onChange={v => setForm(f => ({ ...f, firstName: v }))} required />
            <Field label="Middle Name" value={form.middleName || ""} onChange={v => setForm(f => ({ ...f, middleName: v }))} />
            <Field label="Last Name" value={form.lastName || ""} onChange={v => setForm(f => ({ ...f, lastName: v }))} />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Field label="Company" value={form.company} onChange={v => setForm(f => ({ ...f, company: v }))} />
            <Field label="Job Title" value={form.jobTitle || ""} onChange={v => setForm(f => ({ ...f, jobTitle: v }))} />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Field label="Email" value={form.email} onChange={v => setForm(f => ({ ...f, email: v }))} type="email" />
            <Field label="Phone" value={form.phone} onChange={v => setForm(f => ({ ...f, phone: v }))} />
          </div>
          <Field label="Primary Street 1" value={form.primaryStreet1 || ""} onChange={v => setForm(f => ({ ...f, primaryStreet1: v }))} />
          <Field label="Primary Street 2" value={form.primaryStreet2 || ""} onChange={v => setForm(f => ({ ...f, primaryStreet2: v }))} />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Field label="Primary City" value={form.primaryCity || ""} onChange={v => setForm(f => ({ ...f, primaryCity: v }))} />
            <Field label="Metro Area" value={form.metroArea || ""} onChange={v => setForm(f => ({ ...f, metroArea: v }))} placeholder="e.g. New York, Chicago" />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
            <Field label="Primary State" value={form.primaryState || ""} onChange={v => setForm(f => ({ ...f, primaryState: v }))} />
            <Field label="Primary Zip" value={form.primaryZip || ""} onChange={v => setForm(f => ({ ...f, primaryZip: v }))} />
            <Field label="Primary Country" value={form.primaryCountry || ""} onChange={v => setForm(f => ({ ...f, primaryCountry: v }))} />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Field label="Birthday" value={form.birthday || ""} onChange={v => setForm(f => ({ ...f, birthday: v }))} placeholder="MM/DD/YYYY" />
            <Field label="Website" value={form.website || ""} onChange={v => setForm(f => ({ ...f, website: v }))} placeholder="https://" />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Field label="Industry" value={form.industry || ""} onChange={v => setForm(f => ({ ...f, industry: v }))} />
            <Field label="School / University" value={form.school || ""} onChange={v => setForm(f => ({ ...f, school: v }))} />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Field label="LinkedIn" value={form.linkedIn || ""} onChange={v => setForm(f => ({ ...f, linkedIn: v }))} placeholder="linkedin.com/in/..." />
            <Field label="B/D" value={form.bd || ""} onChange={v => setForm(f => ({ ...f, bd: v }))} />
          </div>
          <Field label="Investments" value={form.investments || ""} onChange={v => setForm(f => ({ ...f, investments: v }))} placeholder="e.g. Series A, Real Estate, Tech" />
          <Field label="Platform Description" value={form.platformDescription || ""} onChange={v => setForm(f => ({ ...f, platformDescription: v }))} as="textarea" />
          <Field label="Research Team" value={form.researchTeam || ""} onChange={v => setForm(f => ({ ...f, researchTeam: v }))} />
          <Field label="Connected / Introduced By" value={form.connectedVia || ""} onChange={v => setForm(f => ({ ...f, connectedVia: v }))} placeholder="e.g. Met at ProductCon, Intro via John Smith" />
          <Sel label="Status" value={form.status} onChange={v => setForm(f => ({ ...f, status: v }))} options={["prospect","active","customer","inactive"].map(s => ({ value: s, label: s.charAt(0).toUpperCase() + s.slice(1) }))} />
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: "block", marginBottom: 6, fontSize: 12, fontWeight: 600, color: "#888", textTransform: "uppercase", letterSpacing: "0.06em" }}>Groups</label>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {groups.map(g => {
                const inGroup = (form.groups || []).includes(g.id);
                return <button key={g.id} onClick={() => setForm(f => ({ ...f, groups: inGroup ? (f.groups || []).filter(x => x !== g.id) : [...(f.groups || []), g.id] }))} style={{ padding: "4px 12px", borderRadius: 20, border: `1px solid ${g.color || "#6366f1"}`, background: inGroup ? (g.color || "#6366f1") : "transparent", color: inGroup ? "#fff" : (g.color || "#6366f1"), cursor: "pointer", fontSize: 12, fontWeight: 600 }}>{g.name}</button>;
              })}
              {groups.length === 0 && <span style={{ color: "#555", fontSize: 12 }}>No groups yet</span>}
            </div>
          </div>
          <Field label="Tags (comma-separated)" value={form.tags} onChange={v => setForm(f => ({ ...f, tags: v }))} placeholder="e.g. enterprise, warm lead" />
          <Field label="Background Info" value={form.backgroundInfo || ""} onChange={v => setForm(f => ({ ...f, backgroundInfo: v }))} as="textarea" placeholder="Career history, interests, context…" />
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
  const [selectedType, setSelectedType] = useState(null); // "manual" or "imported"
  const [search, setSearch] = useState("");
  const COLORS = ["#6366f1","#ec4899","#f59e0b","#10b981","#3b82f6","#8b5cf6","#ef4444","#06b6d4"];

  // Get all unique imported groups from contacts
  const importedGroups = [...new Set(contacts.map(c => c.importGroups).filter(Boolean))].sort();

  function openNew() { setForm({ name: "", description: "", color: "#6366f1" }); setEditing(null); setShowModal(true); }
  function openEdit(g) { setForm(g); setEditing(g); setShowModal(true); }
  async function save() { if (editing) await groupsCol.update(editing.id, form); else await groupsCol.add(form); setShowModal(false); }

  // Contacts for selected group
  const selectedContacts = selected
    ? selectedType === "manual"
      ? contacts.filter(c => (c.groups || []).includes(selected))
      : (groupMap[selected] || [])
    : [];

  const selectedName = selected
    ? selectedType === "manual"
      ? groups.find(g => g.id === selected)?.name
      : selected
    : null;

  const filteredManual = groups.filter(g => g.name.toLowerCase().includes(search.toLowerCase()));
  const filteredImported = importedGroups.filter(g => g.toLowerCase().includes(search.toLowerCase()));

  if (groupsLoading) return <div style={{ textAlign: "center", color: "#555", padding: "60px 0" }}>⟳ Loading all groups… this may take a moment</div>;

  function selectGroup(id, type) {
    if (selected === id && selectedType === type) { setSelected(null); setSelectedType(null); }
    else { setSelected(id); setSelectedType(type); }
  }

  return (
    <div style={{ display: "grid", gridTemplateColumns: selected ? "320px 1fr" : "1fr", gap: 20 }}>
      <div>
        <div style={{ display: "flex", gap: 10, marginBottom: 16, alignItems: "center" }}>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search groups…" style={{ flex: 1, background: "#0d0d14", border: "1px solid #2a2a3a", borderRadius: 8, padding: "8px 14px", color: "#e0e0ff", fontSize: 13, fontFamily: "inherit", outline: "none" }} />
          <Btn size="sm" onClick={openNew}>+ New</Btn>
        </div>

        {/* Manual groups */}
        {filteredManual.length > 0 && <>
          <div style={{ fontSize: 11, fontWeight: 700, color: "#6366f1", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>Custom Groups</div>
          <div style={{ display: "grid", gap: 8, marginBottom: 20 }}>
            {filteredManual.map(g => {
              const count = contacts.filter(c => (c.groups || []).includes(g.id)).length;
              const isSelected = selected === g.id && selectedType === "manual";
              return (
                <div key={g.id} onClick={() => selectGroup(g.id, "manual")} style={{ background: "#0d0d14", border: `1px solid ${isSelected ? g.color || "#6366f1" : "#1e1e2e"}`, borderRadius: 10, padding: "12px 16px", cursor: "pointer", transition: "all 0.15s" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <div style={{ width: 10, height: 10, borderRadius: "50%", background: g.color || "#6366f1", flexShrink: 0 }} />
                    <div style={{ flex: 1 }}><div style={{ fontWeight: 700, color: "#f0f0ff", fontSize: 13 }}>{g.name}</div>{g.description && <div style={{ fontSize: 11, color: "#666" }}>{g.description}</div>}</div>
                    <div style={{ fontSize: 18, fontWeight: 800, color: g.color || "#6366f1", fontFamily: "'Syne', sans-serif" }}>{count}</div>
                  </div>
                  <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                    <Btn size="sm" variant="ghost" onClick={e => { e.stopPropagation(); openEdit(g); }}>Edit</Btn>
                    <Btn size="sm" variant="danger" onClick={e => { e.stopPropagation(); if(window.confirm(`Delete group "${g.name}"?`)) groupsCol.remove(g.id); }}>×</Btn>
                  </div>
                </div>
              );
            })}
          </div>
        </>}

        {/* Imported groups */}
        {filteredImported.length > 0 && <>
          <div style={{ fontSize: 11, fontWeight: 700, color: "#8b5cf6", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>Imported Groups ({filteredImported.length})</div>
          <div style={{ display: "grid", gap: 6 }}>
            {filteredImported.map(g => {
              const count = contacts.filter(c => c.importGroups === g).length;
              const isSelected = selected === g && selectedType === "imported";
              return (
                <div key={g} onClick={() => selectGroup(g, "imported")} style={{ background: "#0d0d14", border: `1px solid ${isSelected ? "#8b5cf6" : "#1e1e2e"}`, borderRadius: 10, padding: "10px 16px", cursor: "pointer", display: "flex", alignItems: "center", gap: 10, transition: "all 0.15s" }}>
                  <div style={{ width: 10, height: 10, borderRadius: "50%", background: "#8b5cf6", flexShrink: 0 }} />
                  <div style={{ flex: 1, fontWeight: 600, color: "#f0f0ff", fontSize: 13 }}>{g}</div>
                  <div style={{ fontSize: 16, fontWeight: 800, color: "#8b5cf6", fontFamily: "'Syne', sans-serif" }}>{count}</div>
                </div>
              );
            })}
          </div>
        </>}

        {filteredManual.length === 0 && filteredImported.length === 0 && (
          <div style={{ textAlign: "center", color: "#555", padding: "40px 0", fontStyle: "italic" }}>No groups found.</div>
        )}
      </div>

      {/* Right panel — group members */}
      {selected && selectedName && (
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 20 }}>
            <div style={{ width: 12, height: 12, borderRadius: "50%", background: selectedType === "imported" ? "#8b5cf6" : (groups.find(g=>g.id===selected)?.color || "#6366f1") }} />
            <h3 style={{ color: "#f0f0ff", fontSize: 16, fontWeight: 700, fontFamily: "'Syne', sans-serif" }}>{selectedName}</h3>
            <span style={{ color: "#555", fontSize: 13 }}>· {selectedContacts.length} contacts</span>
            {selectedType === "imported" && <Tag color="#8b5cf6">imported</Tag>}
          </div>
          <div style={{ display: "grid", gap: 8 }}>
            {selectedContacts.sort((a,b) => (a.lastName||a.name||"").localeCompare(b.lastName||b.name||"")).map(c => (
              <div key={c.id} style={{ background: "#0d0d14", border: "1px solid #1e1e2e", borderRadius: 10, padding: "12px 16px", display: "flex", alignItems: "center", gap: 12 }}>
                <Avatar name={c.name || "?"} size={34} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 700, color: "#f0f0ff", fontSize: 13 }}>{c.lastName ? `${c.lastName}, ${c.firstName||""}` : c.name}</div>
                  <div style={{ fontSize: 11, color: "#888" }}>{c.jobTitle ? `${c.jobTitle} · ` : ""}{c.company}{c.email ? ` · ${c.email}` : ""}</div>
                </div>
                <StatusBadge status={c.status} />
                {selectedType === "manual" && (
                  <Btn size="sm" variant="danger" onClick={() => contactsCol.update(c.id, { groups: (c.groups||[]).filter(g => g !== selected) })}>Remove</Btn>
                )}
              </div>
            ))}
            {selectedContacts.length === 0 && <div style={{ textAlign: "center", color: "#555", padding: "40px 0", fontStyle: "italic" }}>No contacts in this group.</div>}
          </div>
        </div>
      )}

      {showModal && (
        <Modal title={editing ? "Edit Group" : "New Group"} onClose={() => setShowModal(false)}>
          <Field label="Group Name" value={form.name} onChange={v => setForm(f => ({ ...f, name: v }))} required />
          <Field label="Description" value={form.description} onChange={v => setForm(f => ({ ...f, description: v }))} />
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: "block", marginBottom: 8, fontSize: 12, fontWeight: 600, color: "#888", textTransform: "uppercase", letterSpacing: "0.06em" }}>Color</label>
            <div style={{ display: "flex", gap: 8 }}>{COLORS.map(c => <div key={c} onClick={() => setForm(f => ({ ...f, color: c }))} style={{ width: 28, height: 28, borderRadius: "50%", background: c, cursor: "pointer", border: form.color === c ? "3px solid #fff" : "3px solid transparent" }} />)}</div>
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

  const sorted = [...emails].sort((a, b) => {
    const aContact = contacts.find(c => c.id === a.contactId);
    const bContact = contacts.find(c => c.id === b.contactId);
    const aName = (aContact?.lastName || aContact?.name || "").toLowerCase();
    const bName = (bContact?.lastName || bContact?.name || "").toLowerCase();
    if (aName !== bName) return aName.localeCompare(bName);
    const aFirst = (aContact?.firstName || "").toLowerCase();
    const bFirst = (bContact?.firstName || "").toLowerCase();
    return aFirst.localeCompare(bFirst);
  });

  return (
    <div>
      <div style={{ background: "#0d0d14", border: "1px solid #1e1e2e", borderRadius: 12, padding: "16px 20px", marginBottom: 20 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: gmailAccounts.length > 0 ? 12 : 0 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#f0f0ff", marginBottom: 2 }}>Gmail Accounts</div>
            <div style={{ fontSize: 12, color: "#666" }}>{gmailAccounts.length > 0 ? `${gmailAccounts.length} connected${lastSync ? ` · last sync: ${lastSync.toLocaleTimeString()}` : ""}` : "Connect Gmail to auto-sync emails"}</div>
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
                  {e.autoSynced && <span style={{ fontSize: 10, padding: "2px 8px", borderRadius: 20, background: "#10b98110", color: "#10b981", border: "1px solid #10b98130" }}>gmail</span>}
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
    return (
      <div style={{ background: "#0d0d14", border: "1px solid #1e1e2e", borderRadius: 12, padding: 18, display: "flex", gap: 14, alignItems: "flex-start" }}>
        <div style={{ background: "#6366f115", border: "1px solid #6366f130", borderRadius: 10, padding: "8px 14px", textAlign: "center", minWidth: 56 }}>
          <div style={{ fontSize: 11, color: "#6366f1", fontWeight: 700 }}>{m.date ? `${m.date.slice(5,7)}/${m.date.slice(8,10)}` : "--"}</div>
          <div style={{ fontSize: 18, fontWeight: 800, color: "#f0f0ff", fontFamily: "'Syne', sans-serif" }}>{m.date?.slice(0,4) || "--"}</div>
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
            <span style={{ fontWeight: 700, color: "#f0f0ff", fontFamily: "'Syne', sans-serif" }}>{m.title}</span>
            {m.autoSynced && <span style={{ fontSize: 10, padding: "2px 8px", borderRadius: 20, background: "#3b82f610", color: "#3b82f6", border: "1px solid #3b82f630" }}>calendar</span>}
          </div>
          <div style={{ fontSize: 13, color: "#888" }}>{contact ? `${contact.name} · ${contact.company}` : "No contact linked"} · {m.time} · {m.duration}min</div>
          {m.notes && <div style={{ fontSize: 12, color: "#666", fontStyle: "italic", marginTop: 4 }}>{m.notes.slice(0,100)}</div>}
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
      <div style={{ background: "#0d0d14", border: "1px solid #1e1e2e", borderRadius: 12, padding: "14px 20px", marginBottom: 20, display: "flex", alignItems: "center", gap: 12 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: calConnected ? "#10b981" : "#f0f0ff", marginBottom: 2 }}>{calConnected ? "● Google Calendar Connected" : "Connect Google Calendar"}</div>
          <div style={{ fontSize: 12, color: "#666" }}>{calConnected ? "Meetings auto-sync from your calendar" : "Import meetings automatically"}</div>
        </div>
        {calConnected ? <Btn size="sm" variant="ghost" onClick={syncCalendar} disabled={calSyncing}>{calSyncing ? "⟳ Syncing…" : "⟳ Sync Now"}</Btn> : <Btn size="sm" onClick={connectCalendar}>Connect Calendar</Btn>}
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 20 }}><Btn onClick={openNew}>+ Schedule Meeting</Btn></div>
      {upcoming.length > 0 && <><h3 style={{ color: "#9999cc", fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 12 }}>Upcoming</h3><div style={{ display: "grid", gap: 10, marginBottom: 28 }}>{upcoming.map(m => <MeetingCard key={m.id} m={m} />)}</div></>}
      {past.length > 0 && <><h3 style={{ color: "#555", fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 12 }}>Completed</h3><div style={{ display: "grid", gap: 10, opacity: 0.7 }}>{past.map(m => <MeetingCard key={m.id} m={m} />)}</div></>}
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

// ─── COMPANIES TAB ───────────────────────────────────────────────────────────
function CompaniesTab({ emails, meetings }) {
  const { companies: allCompanies, loading: companiesLoading } = useCompanies();
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState(null);
  const [sortDir, setSortDir] = useState("asc");

  const companies = allCompanies
    .filter(co => co.name.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => sortDir === "asc" ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name));

  const selectedCompany = companies.find(co => co.name === selected);

  if (companiesLoading) return <div style={{ textAlign: "center", color: "#555", padding: "60px 0" }}>⟳ Loading all companies… this may take a moment</div>;

  return (
    <div style={{ display: "grid", gridTemplateColumns: selected ? "320px 1fr" : "1fr", gap: 20 }}>
      <div>
        <div style={{ display: "flex", gap: 10, marginBottom: 16, alignItems: "center" }}>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search companies…" style={{ flex: 1, background: "#0d0d14", border: "1px solid #2a2a3a", borderRadius: 8, padding: "8px 14px", color: "#e0e0ff", fontSize: 13, fontFamily: "inherit", outline: "none" }} />
          <button onClick={() => setSortDir(d => d === "asc" ? "desc" : "asc")} style={{ background: "#0d0d14", border: "1px solid #2a2a3a", borderRadius: 8, padding: "8px 12px", color: "#888", cursor: "pointer", fontSize: 12 }}>A-Z {sortDir === "asc" ? "↑" : "↓"}</button>
        </div>
        <div style={{ fontSize: 12, color: "#555", marginBottom: 12 }}>{companies.length} companies</div>
        <div style={{ display: "grid", gap: 8 }}>
          {companies.map(co => {
            const totalPeople = co.contacts.length;
            const isSelected = selected === co.name;
            return (
              <div key={co.name} onClick={() => setSelected(isSelected ? null : co.name)}
                style={{ background: "#0d0d14", border: `1px solid ${isSelected ? "#6366f1" : "#1e1e2e"}`, borderRadius: 10, padding: "12px 16px", cursor: "pointer", display: "flex", alignItems: "center", gap: 12, transition: "all 0.15s" }}>
                <div style={{ width: 36, height: 36, borderRadius: 8, background: "#6366f120", border: "1px solid #6366f130", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, fontWeight: 700, color: "#6366f1", flexShrink: 0 }}>{co.name[0]}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, color: "#f0f0ff", fontSize: 13, fontFamily: "'Syne', sans-serif" }}>{co.name}</div>
                  <div style={{ fontSize: 11, color: "#666" }}>
                    {totalPeople > 0 ? `${totalPeople} contact${totalPeople !== 1 ? "s" : ""}` : "Company only"}
                  </div>
                </div>
                {co.companyOnly && <span style={{ fontSize: 10, padding: "2px 8px", borderRadius: 20, background: "#6366f110", color: "#6366f1", border: "1px solid #6366f130" }}>profile</span>}
              </div>
            );
          })}
          {companies.length === 0 && <div style={{ textAlign: "center", color: "#555", padding: "40px 0", fontStyle: "italic" }}>No companies found.</div>}
        </div>
      </div>

      {selected && selectedCompany && (
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
            <div style={{ width: 44, height: 44, borderRadius: 10, background: "#6366f120", border: "1px solid #6366f130", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, fontWeight: 700, color: "#6366f1" }}>{selectedCompany.name[0]}</div>
            <div>
              <div style={{ fontWeight: 800, color: "#f0f0ff", fontSize: 18, fontFamily: "'Syne', sans-serif" }}>{selectedCompany.name}</div>
              <div style={{ fontSize: 12, color: "#666" }}>{selectedCompany.contacts.length} people in CRM</div>
            </div>
          </div>

          {/* Company profile info if exists */}
          {selectedCompany.companyOnly && (
            <div style={{ background: "#0d0d14", border: "1px solid #6366f130", borderRadius: 10, padding: "14px 18px", marginBottom: 16 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#6366f1", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 10 }}>Company Profile</div>
              <div style={{ display: "grid", gap: 6 }}>
                {selectedCompany.companyOnly.jobTitle && <div style={{ fontSize: 13, color: "#ccc" }}><span style={{ color: "#666" }}>Type: </span>{selectedCompany.companyOnly.jobTitle}</div>}
                {selectedCompany.companyOnly.industry && <div style={{ fontSize: 13, color: "#ccc" }}><span style={{ color: "#666" }}>Industry: </span>{selectedCompany.companyOnly.industry}</div>}
                {selectedCompany.companyOnly.phone && <div style={{ fontSize: 13, color: "#ccc" }}><span style={{ color: "#666" }}>Phone: </span>{selectedCompany.companyOnly.phone}</div>}
                {selectedCompany.companyOnly.email && <div style={{ fontSize: 13, color: "#ccc" }}><span style={{ color: "#666" }}>Email: </span>{selectedCompany.companyOnly.email}</div>}
                {selectedCompany.companyOnly.website && <div style={{ fontSize: 13, color: "#ccc" }}><span style={{ color: "#666" }}>Website: </span>{selectedCompany.companyOnly.website}</div>}
                {selectedCompany.companyOnly.primaryCity && <div style={{ fontSize: 13, color: "#ccc" }}><span style={{ color: "#666" }}>Location: </span>{[selectedCompany.companyOnly.primaryCity, selectedCompany.companyOnly.primaryState, selectedCompany.companyOnly.primaryCountry].filter(Boolean).join(", ")}</div>}
                {selectedCompany.companyOnly.notes && <div style={{ fontSize: 13, color: "#888", fontStyle: "italic", marginTop: 4 }}>{selectedCompany.companyOnly.notes}</div>}
              </div>
            </div>
          )}

          {/* People at this company */}
          {selectedCompany.contacts.length > 0 ? (
            <div style={{ display: "grid", gap: 10 }}>
              {selectedCompany.contacts.sort((a,b) => (a.lastName||a.name||"").localeCompare(b.lastName||b.name||"")).map(c => {
                const cEmails = emails.filter(e => e.contactId === c.id).length;
                const cMeetings = meetings.filter(m => m.contactId === c.id).length;
                const health = calcHealthScore(c, emails, meetings);
                return (
                  <div key={c.id} style={{ background: "#0d0d14", border: "1px solid #1e1e2e", borderRadius: 10, padding: "14px 18px", display: "flex", alignItems: "center", gap: 12 }}>
                    <Avatar name={c.name || "?"} size={36} />
                    <div style={{ flex: 1 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
                        <span style={{ fontWeight: 700, color: "#f0f0ff", fontSize: 13 }}>{c.lastName ? `${c.lastName}, ${c.firstName||""}` : c.name}</span>
                        <StatusBadge status={c.status} />
                      </div>
                      <div style={{ fontSize: 12, color: "#888", marginBottom: 4 }}>{c.jobTitle}{c.jobTitle && c.email ? " · " : ""}{c.email}</div>
                      <HealthBar score={health.score} color={health.color} label={health.label} size="sm" />
                    </div>
                    <div style={{ display: "flex", gap: 12, color: "#666", fontSize: 11, textAlign: "center" }}>
                      <div><div style={{ fontSize: 14, fontWeight: 700, color: "#9999cc" }}>{cEmails}</div>emails</div>
                      <div><div style={{ fontSize: 14, fontWeight: 700, color: "#9999cc" }}>{cMeetings}</div>mtgs</div>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div style={{ textAlign: "center", color: "#555", padding: "40px 0", fontStyle: "italic" }}>No individual contacts at this company yet.</div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── PIPELINE TAB ─────────────────────────────────────────────────────────────
function PipelineTab({ contacts, pipelinesCol }) {
  const STAGES = ["Lead", "Qualified", "Proposal", "Negotiation", "Closed Won", "Closed Lost"];
  const STAGE_COLORS = { "Lead": "#6366f1", "Qualified": "#3b82f6", "Proposal": "#f59e0b", "Negotiation": "#ec4899", "Closed Won": "#10b981", "Closed Lost": "#6b7280" };
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState({ contactId: "", title: "", value: "", stage: "Lead", notes: "" });
  const [dragging, setDragging] = useState(null);

  async function save() {
    await pipelinesCol.add({ ...form, value: Number(form.value) || 0, createdAt: new Date().toISOString() });
    setShowModal(false);
    setForm({ contactId: "", title: "", value: "", stage: "Lead", notes: "" });
  }

  async function moveStage(deal, stage) {
    await pipelinesCol.update(deal.id, { stage });
  }

  const totalValue = pipelinesCol.docs.filter(d => d.stage === "Closed Won").reduce((sum, d) => sum + (d.value || 0), 0);
  const pipelineValue = pipelinesCol.docs.filter(d => !["Closed Won","Closed Lost"].includes(d.stage)).reduce((sum, d) => sum + (d.value || 0), 0);

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <div style={{ display: "flex", gap: 20 }}>
          <div style={{ background: "#0d0d14", border: "1px solid #1a1a2a", borderRadius: 10, padding: "10px 20px" }}>
            <div style={{ fontSize: 11, color: "#666", marginBottom: 2 }}>Pipeline Value</div>
            <div style={{ fontSize: 20, fontWeight: 800, color: "#f59e0b", fontFamily: "'Syne', sans-serif" }}>${pipelineValue.toLocaleString()}</div>
          </div>
          <div style={{ background: "#0d0d14", border: "1px solid #1a1a2a", borderRadius: 10, padding: "10px 20px" }}>
            <div style={{ fontSize: 11, color: "#666", marginBottom: 2 }}>Closed Won</div>
            <div style={{ fontSize: 20, fontWeight: 800, color: "#10b981", fontFamily: "'Syne', sans-serif" }}>${totalValue.toLocaleString()}</div>
          </div>
        </div>
        <Btn onClick={() => setShowModal(true)}>+ New Deal</Btn>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 10, overflowX: "auto" }}>
        {STAGES.map(stage => {
          const deals = pipelinesCol.docs.filter(d => d.stage === stage);
          const stageValue = deals.reduce((sum, d) => sum + (d.value || 0), 0);
          const color = STAGE_COLORS[stage];
          return (
            <div key={stage} style={{ background: "#0d0d14", border: "1px solid #1a1a2a", borderRadius: 12, padding: 12, minHeight: 300 }}
              onDragOver={e => e.preventDefault()}
              onDrop={e => { e.preventDefault(); if (dragging) moveStage(dragging, stage); setDragging(null); }}>
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4 }}>{stage}</div>
                <div style={{ fontSize: 12, color: "#555" }}>{deals.length} deals · ${stageValue.toLocaleString()}</div>
              </div>
              <div style={{ display: "grid", gap: 8 }}>
                {deals.map(deal => {
                  const contact = contacts.find(c => c.id === deal.contactId);
                  return (
                    <div key={deal.id} draggable onDragStart={() => setDragging(deal)}
                      style={{ background: "#080810", border: `1px solid ${color}30`, borderRadius: 8, padding: "10px 12px", cursor: "grab" }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: "#f0f0ff", marginBottom: 4 }}>{deal.title}</div>
                      {contact && <div style={{ fontSize: 11, color: "#888", marginBottom: 4 }}>{contact.name}</div>}
                      {deal.value > 0 && <div style={{ fontSize: 12, fontWeight: 700, color }}>${deal.value.toLocaleString()}</div>}
                      <div style={{ display: "flex", gap: 4, marginTop: 6, flexWrap: "wrap" }}>
                        {STAGES.filter(s => s !== stage).slice(0, 2).map(s => (
                          <button key={s} onClick={() => moveStage(deal, s)} style={{ fontSize: 9, padding: "2px 6px", borderRadius: 4, border: `1px solid ${STAGE_COLORS[s]}40`, background: "transparent", color: STAGE_COLORS[s], cursor: "pointer" }}>→ {s}</button>
                        ))}
                        <button onClick={() => pipelinesCol.remove(deal.id)} style={{ fontSize: 9, padding: "2px 6px", borderRadius: 4, border: "1px solid #ef444440", background: "transparent", color: "#ef4444", cursor: "pointer", marginLeft: "auto" }}>×</button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {showModal && (
        <Modal title="New Deal" onClose={() => setShowModal(false)}>
          <Field label="Deal Title" value={form.title} onChange={v => setForm(f => ({ ...f, title: v }))} required />
          <Sel label="Contact" value={form.contactId} onChange={v => setForm(f => ({ ...f, contactId: v }))} options={[{ value: "", label: "-- Select contact --" }, ...contacts.map(c => ({ value: c.id, label: `${c.name} — ${c.company}` }))]} />
          <Field label="Value ($)" value={form.value} onChange={v => setForm(f => ({ ...f, value: v }))} type="number" placeholder="0" />
          <Sel label="Stage" value={form.stage} onChange={v => setForm(f => ({ ...f, stage: v }))} options={STAGES.map(s => ({ value: s, label: s }))} />
          <Field label="Notes" value={form.notes} onChange={v => setForm(f => ({ ...f, notes: v }))} as="textarea" />
          <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
            <Btn variant="ghost" onClick={() => setShowModal(false)}>Cancel</Btn>
            <Btn onClick={save} disabled={!form.title}>Save Deal</Btn>
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
      await col.add({ name: file.name, url: null, uploadedAt: new Date().toISOString(), size: file.size });
    }
    setUploading(false);
  }

  async function analyzeMatches(deck) {
    setAnalyzing(deck.id);
    try {
      const result = await callClaudeJSON(`I have a pitch deck named "${deck.name}". Based on the filename and contact list, suggest best-fit contacts. Return ONLY JSON with keys: "analysis" (2-3 sentences about what this deck covers), "topMatches" (array of contact names, max 5), "reasoning" (one sentence).\n\nContacts: ${contacts.map(c => `${c.name} (${c.company}, ${c.status}${c.tags?.length ? ", " + c.tags.join(", ") : ""})`).join("; ")}`);
      setResults(r => ({ ...r, [deck.id]: result }));
    } catch (e) {
      setResults(r => ({ ...r, [deck.id]: { error: "Analysis failed." } }));
    }
    setAnalyzing(null);
  }

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <div><h3 style={{ color: "#f0f0ff", fontSize: 16, fontWeight: 700, fontFamily: "'Syne', sans-serif", marginBottom: 4 }}>Pitch Decks</h3><p style={{ color: "#666", fontSize: 12 }}>Upload decks and AI matches them to your best-fit contacts</p></div>
        <div><input ref={fileRef} type="file" accept=".pdf,.pptx,.ppt" style={{ display: "none" }} onChange={handleUpload} /><Btn onClick={() => fileRef.current.click()} disabled={uploading}>{uploading ? "Uploading…" : "⬆ Upload Deck"}</Btn></div>
      </div>
      <div style={{ display: "grid", gap: 16 }}>
        {col.docs.map(deck => {
          const result = results[deck.id];
          const matchedContacts = result?.topMatches ? contacts.filter(c => result.topMatches.some(name => c.name?.toLowerCase().includes(name.toLowerCase()))) : [];
          return (
            <div key={deck.id} style={{ background: "#0d0d14", border: "1px solid #1e1e2e", borderRadius: 12, padding: 20 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: result ? 16 : 0 }}>
                <div style={{ width: 44, height: 44, borderRadius: 10, background: "#6366f120", border: "1px solid #6366f130", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20 }}>📊</div>
                <div style={{ flex: 1 }}><div style={{ fontWeight: 700, color: "#f0f0ff", fontFamily: "'Syne', sans-serif" }}>{deck.name}</div><div style={{ fontSize: 12, color: "#666" }}>Uploaded {new Date(deck.uploadedAt).toLocaleDateString()}</div></div>
                <div style={{ display: "flex", gap: 8 }}>
                  <Btn size="sm" onClick={() => analyzeMatches(deck)} disabled={analyzing === deck.id}>{analyzing === deck.id ? "✦ Analyzing…" : "✦ Find Best Fits"}</Btn>
                  <Btn size="sm" variant="danger" onClick={() => col.remove(deck.id)}>×</Btn>
                </div>
              </div>
              {result && !result.error && (
                <div style={{ background: "#080810", borderRadius: 10, padding: 16 }}>
                  <div style={{ fontSize: 12, color: "#888", marginBottom: 12, lineHeight: 1.6 }}>{result.analysis}</div>
                  <div style={{ fontSize: 11, fontWeight: 700, color: "#6366f1", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 10 }}>Best Fits</div>
                  {(matchedContacts.length > 0 ? matchedContacts : []).map(c => (
                    <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", background: "#0d0d14", borderRadius: 8, border: "1px solid #1e1e2e", marginBottom: 6 }}>
                      <Avatar name={c.name} size={28} /><div><div style={{ fontSize: 13, fontWeight: 700, color: "#f0f0ff" }}>{c.name}</div><div style={{ fontSize: 11, color: "#666" }}>{c.company}</div></div>
                      <StatusBadge status={c.status} />
                    </div>
                  ))}
                  {result.reasoning && <div style={{ fontSize: 12, color: "#555", marginTop: 8, fontStyle: "italic" }}>{result.reasoning}</div>}
                </div>
              )}
            </div>
          );
        })}
        {col.docs.length === 0 && <div style={{ textAlign: "center", color: "#555", padding: "60px 0" }}><div style={{ fontSize: 40, marginBottom: 12 }}>📊</div><div>No pitch decks yet.</div></div>}
      </div>
    </div>
  );
}

// ─── NEWS TAB ─────────────────────────────────────────────────────────────────
function NewsTab({ contacts }) {
  const [selected, setSelected] = useState(null);
  const [news, setNews] = useState({});
  const [loading, setLoading] = useState(false);

  async function fetchNews(c) {
    setSelected(c.id);
    if (news[c.id]) return;
    setLoading(true);
    try {
      if (NEWS_API_KEY === "PASTE_YOUR_NEWS_API_KEY") {
        setNews(n => ({ ...n, [c.id]: [
          { title: `${c.name} — sample article`, description: "Get a free API key at newsapi.org to see real news.", url: "#", publishedAt: new Date().toISOString(), source: { name: "Demo" } },
        ]}));
      } else {
        const query = encodeURIComponent(`"${c.name}" OR "${c.company}"`);
        const res = await fetch(`https://newsapi.org/v2/everything?q=${query}&sortBy=publishedAt&pageSize=10&apiKey=${NEWS_API_KEY}`);
        const data = await res.json();
        setNews(n => ({ ...n, [c.id]: data.articles || [] }));
      }
    } catch (e) { setNews(n => ({ ...n, [c.id]: [] })); }
    setLoading(false);
  }

  const contact = contacts.find(c => c.id === selected);

  return (
    <div style={{ display: "grid", gridTemplateColumns: "280px 1fr", gap: 20 }}>
      <div>
        <h3 style={{ color: "#9999cc", fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 12 }}>Select Contact</h3>
        <div style={{ display: "grid", gap: 8 }}>
          {contacts.map(c => (
            <div key={c.id} onClick={() => fetchNews(c)} style={{ background: "#0d0d14", border: `1px solid ${selected === c.id ? "#6366f1" : "#1e1e2e"}`, borderRadius: 10, padding: "12px 14px", cursor: "pointer", display: "flex", alignItems: "center", gap: 10 }}>
              <Avatar name={c.name || "?"} size={32} />
              <div><div style={{ fontWeight: 700, color: "#f0f0ff", fontSize: 13 }}>{c.name}</div><div style={{ fontSize: 11, color: "#666" }}>{c.company}</div></div>
            </div>
          ))}
        </div>
        {NEWS_API_KEY === "PASTE_YOUR_NEWS_API_KEY" && <div style={{ marginTop: 16, background: "#f59e0b10", border: "1px solid #f59e0b30", borderRadius: 8, padding: "10px 12px", fontSize: 11, color: "#f59e0b", lineHeight: 1.5 }}>Get a free key at <strong>newsapi.org</strong> for real news.</div>}
      </div>
      <div>
        {!selected && <div style={{ textAlign: "center", color: "#555", padding: "60px 0" }}><div style={{ fontSize: 40, marginBottom: 12 }}>📰</div>Select a contact</div>}
        {selected && loading && <Spinner />}
        {selected && !loading && contact && (
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}><Avatar name={contact.name} size={40} /><div><div style={{ fontWeight: 700, color: "#f0f0ff", fontSize: 16, fontFamily: "'Syne', sans-serif" }}>{contact.name}</div><div style={{ fontSize: 13, color: "#888" }}>{contact.company}</div></div></div>
            <div style={{ display: "grid", gap: 12 }}>
              {(news[selected] || []).length === 0 && <div style={{ textAlign: "center", color: "#555", padding: "40px 0", fontStyle: "italic" }}>No news found.</div>}
              {(news[selected] || []).map((article, i) => (
                <a key={i} href={article.url} target="_blank" rel="noopener noreferrer" style={{ textDecoration: "none" }}>
                  <div style={{ background: "#0d0d14", border: "1px solid #1e1e2e", borderRadius: 12, padding: 16 }} onMouseEnter={e => e.currentTarget.style.borderColor = "#6366f1"} onMouseLeave={e => e.currentTarget.style.borderColor = "#1e1e2e"}>
                    <div style={{ fontWeight: 700, color: "#f0f0ff", fontSize: 14, marginBottom: 6, lineHeight: 1.4 }}>{article.title}</div>
                    {article.description && <div style={{ fontSize: 12, color: "#888", lineHeight: 1.5, marginBottom: 8 }}>{article.description.slice(0,150)}…</div>}
                    <div style={{ display: "flex", gap: 12, fontSize: 11, color: "#555" }}><span>{article.source?.name}</span><span>{new Date(article.publishedAt).toLocaleDateString()}</span></div>
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
      const r = await callClaudeJSON(`Write a cold outreach email. Return ONLY JSON with "subject" and "body".\n\nProspect: ${contact.name}, ${contact.company}\nTags: ${(contact.tags||[]).join(", ")}\nNotes: ${contact.notes||"N/A"}\nContext: ${context||"None"}\nTone: ${tone}\n\nPersonalized, concise, soft CTA for 15-min call.`);
      setResult(r);
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
          {contact && <div style={{ background: "#0d0d14", border: "1px solid #1e1e2e", borderRadius: 10, padding: 16, display: "flex", gap: 12, alignItems: "center" }}><Avatar name={contact.name} size={40} /><div><div style={{ fontWeight: 700, color: "#f0f0ff" }}>{contact.name}</div><div style={{ fontSize: 13, color: "#888" }}>{contact.company} · {contact.email}</div></div></div>}
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
              {[...col.docs].sort((a, b) => (b.sentAt||"").localeCompare(a.sentAt||"")).map((s, i) => (
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
  const [tab, setTab] = useState("Dashboard");
  const contactsCol = usePaginatedContacts();
  const emailsCol = useCollection("emails");
  const meetingsCol = useCollection("meetings");
  const groupsCol = useCollection("groups");
  const gmailAccountsCol = useCollection("gmail_accounts");
  const pipelinesCol = useCollection("pipeline");

  const { syncing, lastSync, connectGmail, syncAll } = useGmailSync(contactsCol.docs, emailsCol, gmailAccountsCol.docs);
  const { calConnected, syncing: calSyncing, connectCalendar, syncCalendar } = useGoogleCalendar(contactsCol.docs, meetingsCol);

  const loading = emailsCol.loading || meetingsCol.loading || groupsCol.loading;

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
          <div style={{ display: "flex", gap: 16, fontSize: 11 }}>
            <span style={{ color: gmailAccountsCol.docs.length > 0 ? "#10b981" : "#555" }}>{gmailAccountsCol.docs.length > 0 ? `● ${gmailAccountsCol.docs.length} Gmail` : "○ Gmail"}</span>
            <span style={{ color: calConnected ? "#10b981" : "#555" }}>{calConnected ? "● Calendar" : "○ Calendar"}</span>
          </div>
        </div>

        <div style={{ padding: "24px", maxWidth: 1400, margin: "0 auto" }}>
          {firebaseConfig.apiKey === "PASTE_YOUR_API_KEY" && (
            <div style={{ background: "#f59e0b15", border: "1px solid #f59e0b40", borderRadius: 12, padding: "16px 20px", marginBottom: 24, fontSize: 13, color: "#f59e0b" }}>
              ⚠️ <strong>Setup required:</strong> Replace the <code>firebaseConfig</code> values at the top of this file with your Firebase credentials.
            </div>
          )}

          <div style={{ display: "flex", gap: 3, marginBottom: 24, background: "#0d0d14", border: "1px solid #1a1a2a", borderRadius: 10, padding: 4, overflowX: "auto" }}>
            {TABS.map(t => (
              <button key={t} onClick={() => setTab(t)} style={{ flex: 1, minWidth: "fit-content", padding: "9px 12px", borderRadius: 8, border: "none", background: tab === t ? "#6366f1" : "transparent", color: tab === t ? "#fff" : "#666", fontWeight: 700, cursor: "pointer", fontFamily: "'Syne', sans-serif", fontSize: 12, transition: "all 0.15s", whiteSpace: "nowrap" }}>
                {t === "Dashboard" && "⬡ "}{t === "Outreach" ? <>{t}<span style={{ marginLeft: 4, background: tab === t ? "#ffffff30" : "#6366f130", color: tab === t ? "#fff" : "#6366f1", borderRadius: 20, padding: "1px 6px", fontSize: 9 }}>AI</span></> : t}
              </button>
            ))}
          </div>

          <div style={{ animation: "fadeIn 0.2s ease" }} key={tab}>
            {loading ? <Spinner /> : <>
              {tab === "Dashboard" && <DashboardTab contacts={contactsCol.docs} emails={emailsCol.docs} meetings={meetingsCol.docs} emailsCol={emailsCol} totalContacts={contactsCol.totalCount} />}
              {tab === "Contacts" && <ContactsTab contactsCol={contactsCol} emails={emailsCol.docs} meetings={meetingsCol.docs} groups={groupsCol.docs} />}
              {tab === "Companies" && <CompaniesTab emails={emailsCol.docs} meetings={meetingsCol.docs} />}
              {tab === "Groups" && <GroupsTab groups={groupsCol.docs} groupsCol={groupsCol} contacts={contactsCol.docs} contactsCol={contactsCol} />}
              {tab === "Emails" && <EmailsTab emails={emailsCol.docs} contacts={contactsCol.docs} emailsCol={emailsCol} gmailAccounts={gmailAccountsCol.docs} gmailAccountsCol={gmailAccountsCol} syncing={syncing} lastSync={lastSync} connectGmail={connectGmail} syncAll={syncAll} />}
              {tab === "Meetings" && <MeetingsTab meetings={meetingsCol.docs} contacts={contactsCol.docs} meetingsCol={meetingsCol} calConnected={calConnected} calSyncing={calSyncing} connectCalendar={connectCalendar} syncCalendar={syncCalendar} />}
              {tab === "Pipeline" && <PipelineTab contacts={contactsCol.docs} pipelinesCol={pipelinesCol} />}
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

