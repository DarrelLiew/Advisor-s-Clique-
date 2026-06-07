// Sidebar nav + Top nav

function Sidebar({ active = "Dashboard", onNavigate = () => {} }) {
  const items = [
    { name: "Dashboard", icon: ICONS.dashboard },
    { name: "Chat", icon: ICONS.chat, badge: 3 },
    { name: "Documents", icon: ICONS.docs },
    { name: "Users", icon: ICONS.users },
    { name: "Analytics", icon: ICONS.analytics },
    { name: "Uploads", icon: ICONS.uploads },
    { name: "Telegram Bot", icon: ICONS.telegram },
  ];
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">✦</div>
        <div className="brand-text">
          <div className="name">Knowledge Base</div>
          <div className="sub">Admin Console</div>
        </div>
      </div>

      <div className="nav-group">
        <div className="label">Workspace</div>
        {items.slice(0, 4).map(it => (
          <button key={it.name} className={"nav-item " + (it.name === active ? "active" : "")} onClick={() => onNavigate(it.name)}>
            {it.icon}
            <span>{it.name}</span>
            {it.badge && <span className="badge">{it.badge}</span>}
          </button>
        ))}
      </div>

      <div className="nav-group">
        <div className="label">Insights</div>
        {items.slice(4).map(it => (
          <button key={it.name} className={"nav-item " + (it.name === active ? "active" : "")} onClick={() => onNavigate(it.name)}>
            {it.icon}
            <span>{it.name}</span>
          </button>
        ))}
      </div>

      <div className="side-card">
        <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--gold)", marginBottom: 4 }}>System health</div>
        <div className="title">All systems online</div>
        <div className="body">n8n · Supabase · OpenAI · Telegram</div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span className="pip green"></span>
          <span style={{ fontSize: 11.5, color: "var(--muted)" }}>Uptime <b style={{ color: "var(--ink)" }}>99.94%</b> · 30d</span>
        </div>
      </div>

      <button className="nav-item" style={{ marginTop: 4 }}>
        {ICONS.settings}
        <span>Settings</span>
      </button>

      <div className="side-user" style={{ borderTop: "1px solid var(--line)", paddingTop: 12, marginTop: 4 }}>
        <div className="avatar">EW</div>
        <div className="meta" style={{ flex: 1 }}>
          <div className="n">Evelyn Wong</div>
          <div className="r">Administrator</div>
        </div>
        <button className="icon-btn" style={{ width: 28, height: 28, border: "none" }} title="Sign out">
          {ICONS.logout}
        </button>
      </div>
    </aside>
  );
}

function TopNav({ active = "Dashboard", onNavigate = () => {} }) {
  const items = [
    { name: "Dashboard", icon: ICONS.dashboard },
    { name: "Chat", icon: ICONS.chat },
    { name: "Documents", icon: ICONS.docs },
    { name: "Users", icon: ICONS.users },
    { name: "Analytics", icon: ICONS.analytics },
  ];
  return (
    <div className="topnav-bar">
      <div className="brand" style={{ padding: 0, marginRight: 8 }}>
        <div className="brand-mark" style={{ width: 32, height: 32, fontSize: 16 }}>✦</div>
        <div className="brand-text">
          <div className="name" style={{ fontSize: 15 }}>Knowledge Base</div>
        </div>
      </div>
      <div style={{ display: "flex", gap: 4, marginLeft: 12 }}>
        {items.map(it => (
          <button key={it.name} className={"nav-item " + (it.name === active ? "active" : "")} onClick={() => onNavigate(it.name)}>
            {it.icon}
            <span>{it.name}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

Object.assign(window, { Sidebar, TopNav });
