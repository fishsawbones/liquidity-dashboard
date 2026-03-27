import { useState, useEffect, useCallback, useMemo } from "react";
import {
  ComposedChart,
  Line,
  Area,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts";

/* ── helpers ── */
const fmt = (v) => {
  if (v == null) return "—";
  const abs = Math.abs(v);
  const sign = v < 0 ? "-" : "+";
  if (abs >= 1e6) return sign + "$" + (abs / 1e6).toFixed(1) + "T";
  if (abs >= 1e3) return sign + "$" + (abs / 1e3).toFixed(0) + "B";
  return sign + "$" + abs.toFixed(0) + "M";
};

const fmtAxis = (v) => {
  if (v == null) return "";
  const abs = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (abs >= 1e6) return sign + (abs / 1e6).toFixed(1) + "T";
  if (abs >= 1e3) return sign + (abs / 1e3).toFixed(0) + "B";
  return sign + abs.toFixed(0) + "M";
};

const fmtLevel = (v) => {
  if (v == null) return "";
  return "$" + (v / 1e6).toFixed(1) + "T";
};

const fmtBTC = (v) => {
  if (v == null) return "—";
  return "$" + v.toLocaleString("en-US", { maximumFractionDigits: 0 });
};

const fmtDate = (d) => {
  const [y, m] = d.split("-");
  const months = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return months[parseInt(m)] + " '" + y.slice(2);
};

/* ── FRED fetch (via serverless proxy) ── */
async function fetchFRED(seriesId, start = "2014-01-01") {
  const url = `/api/fred?series_id=${seriesId}&observation_start=${start}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FRED error for ${seriesId}: ${res.status}`);
  const json = await res.json();
  return json.observations
    .filter((o) => o.value !== ".")
    .map((o) => ({ date: o.date, value: parseFloat(o.value) }));
}

/* ── normalize everything to $M ── */
function toMillions(seriesId, value) {
  if (seriesId === "TOTLL") return value * 1000;
  return value;
}

/* ── merge + compute both impulse and level data ── */
function buildAllData(datasets) {
  const map = {};
  for (const [sid, pts] of Object.entries(datasets)) {
    for (const p of pts) {
      if (!map[p.date]) map[p.date] = { date: p.date };
      if (sid === "CBBTCUSD") {
        map[p.date].btc = p.value;
      } else {
        map[p.date][sid] = toMillions(sid, p.value);
      }
    }
  }

  const sorted = Object.values(map).sort((a, b) => a.date.localeCompare(b.date));

  // forward-fill weekly series
  let last = {};
  for (const row of sorted) {
    for (const k of ["WALCL", "WTREGEN", "TOTLL"]) {
      if (row[k] != null) last[k] = row[k];
      else if (last[k] != null) row[k] = last[k];
    }
  }

  // Build level data: Net Liquidity = Fed BS - TGA + Loans
  // TGA subtracted: when TGA goes down (spending), net liquidity goes UP
  const levelData = [];
  for (const row of sorted) {
    if (row.WALCL == null || row.WTREGEN == null || row.TOTLL == null) continue;
    const netLiquidity = row.WALCL - row.WTREGEN + row.TOTLL;
    levelData.push({
      date: row.date,
      netLiquidity,
      walcl: row.WALCL,
      tga: row.WTREGEN,
      totll: row.TOTLL,
      btc: row.btc ?? null,
    });
  }

  // Build impulse data (4-week rolling change)
  const impulseData = [];
  for (let i = 0; i < sorted.length; i++) {
    const curr = sorted[i];
    if (curr.WALCL == null || curr.WTREGEN == null || curr.TOTLL == null) continue;

    const targetDate = new Date(curr.date);
    targetDate.setDate(targetDate.getDate() - 28);
    const targetStr = targetDate.toISOString().slice(0, 10);

    let prev = null;
    for (let j = i - 1; j >= 0; j--) {
      if (sorted[j].date <= targetStr && sorted[j].WALCL != null) {
        prev = sorted[j];
        break;
      }
    }
    if (!prev) continue;

    const dBS = curr.WALCL - prev.WALCL;
    const dTGA = -(curr.WTREGEN - prev.WTREGEN);
    const dLoans = curr.TOTLL - prev.TOTLL;
    const composite = dBS + dTGA + dLoans;

    impulseData.push({
      date: curr.date,
      dBS, dTGA, dLoans, composite,
      btc: curr.btc ?? null,
      _walcl: curr.WALCL,
      _tga: curr.WTREGEN,
      _totll: curr.TOTLL,
    });
  }

  return {
    impulse: impulseData.filter((r) => r.date >= "2020-01-01"),
    level: levelData.filter((r) => r.date >= "2014-01-01"),
  };
}

/* ── stat card ── */
const StatCard = ({ label, value, sub, color }) => (
  <div style={{
    background: "rgba(255,255,255,0.025)",
    border: "1px solid rgba(255,255,255,0.06)",
    borderRadius: 8,
    padding: "14px 18px",
    flex: 1,
    minWidth: 140,
  }}>
    <div style={{
      fontSize: 10, color: "#6B7D8D", letterSpacing: "0.1em",
      textTransform: "uppercase", marginBottom: 7,
      fontFamily: "'IBM Plex Mono', monospace",
    }}>{label}</div>
    <div style={{
      fontSize: 19, fontWeight: 700, color: color || "#E2E8EE",
      fontFamily: "'IBM Plex Mono', monospace",
    }}>{value}</div>
    {sub && (
      <div style={{
        fontSize: 10, color: "#5A6B7D", marginTop: 5,
        fontFamily: "'IBM Plex Mono', monospace",
      }}>{sub}</div>
    )}
  </div>
);

/* ── impulse tooltip ── */
const ImpulseTooltip = ({ active, payload }) => {
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload;
  if (!row) return null;
  const items = [
    { label: "Δ Fed BS", val: row.dBS, color: "#4FC3F7" },
    { label: "TGA Spend", val: row.dTGA, color: "#FF8A65" },
    { label: "Δ Loans", val: row.dLoans, color: "#AED581" },
  ];
  return (
    <div style={{
      background: "#141B24", border: "1px solid rgba(255,255,255,0.1)",
      borderRadius: 8, padding: "14px 18px", fontSize: 12,
      fontFamily: "'IBM Plex Mono', monospace", minWidth: 210,
    }}>
      <div style={{ color: "#8899AA", marginBottom: 10, fontSize: 11 }}>{row.date}</div>
      {items.map((it, i) => (
        <div key={i} style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
          <span style={{ color: it.color }}>{it.label}</span>
          <span style={{ color: it.val >= 0 ? "#66BB6A" : "#EF5350", fontWeight: 600 }}>{fmt(it.val)}</span>
        </div>
      ))}
      <div style={{
        borderTop: "1px solid rgba(255,255,255,0.08)", paddingTop: 6, marginTop: 6,
        display: "flex", justifyContent: "space-between",
      }}>
        <span style={{ color: "#E2E8EE", fontWeight: 700 }}>Composite</span>
        <span style={{ color: row.composite >= 0 ? "#66BB6A" : "#EF5350", fontWeight: 700 }}>{fmt(row.composite)}</span>
      </div>
      {row.btc != null && (
        <div style={{
          borderTop: "1px solid rgba(255,255,255,0.08)", paddingTop: 6, marginTop: 6,
          display: "flex", justifyContent: "space-between",
        }}>
          <span style={{ color: "#F7931A" }}>Bitcoin</span>
          <span style={{ color: "#F7931A", fontWeight: 600 }}>{fmtBTC(row.btc)}</span>
        </div>
      )}
    </div>
  );
};

/* ── level tooltip ── */
const LevelTooltip = ({ active, payload }) => {
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload;
  if (!row) return null;
  return (
    <div style={{
      background: "#141B24", border: "1px solid rgba(255,255,255,0.1)",
      borderRadius: 8, padding: "14px 18px", fontSize: 12,
      fontFamily: "'IBM Plex Mono', monospace", minWidth: 220,
    }}>
      <div style={{ color: "#8899AA", marginBottom: 10, fontSize: 11 }}>{row.date}</div>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
        <span style={{ color: "#81D4FA" }}>Net Liquidity</span>
        <span style={{ color: "#81D4FA", fontWeight: 700 }}>{fmtLevel(row.netLiquidity)}</span>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
        <span style={{ color: "#4FC3F7" }}>Fed BS</span>
        <span style={{ color: "#667" }}>{fmtLevel(row.walcl)}</span>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
        <span style={{ color: "#FF8A65" }}>TGA (drain)</span>
        <span style={{ color: "#667" }}>−{fmtLevel(row.tga)}</span>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
        <span style={{ color: "#AED581" }}>Loans</span>
        <span style={{ color: "#667" }}>{fmtLevel(row.totll)}</span>
      </div>
      {row.btc != null && (
        <div style={{
          borderTop: "1px solid rgba(255,255,255,0.08)", paddingTop: 6, marginTop: 6,
          display: "flex", justifyContent: "space-between",
        }}>
          <span style={{ color: "#F7931A" }}>Bitcoin</span>
          <span style={{ color: "#F7931A", fontWeight: 600 }}>{fmtBTC(row.btc)}</span>
        </div>
      )}
    </div>
  );
};

/* ══════ MAIN ══════ */
export default function LiquidityDashboard() {
  const [allData, setAllData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showBTC, setShowBTC] = useState(true);
  const [timeRange, setTimeRange] = useState("all");
  const [leadWeeks, setLeadWeeks] = useState(10);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [walcl, tga, totll, btc] = await Promise.all([
        fetchFRED("WALCL"),
        fetchFRED("WTREGEN"),
        fetchFRED("TOTLL"),
        fetchFRED("CBBTCUSD"),
      ]);
      const result = buildAllData({ WALCL: walcl, WTREGEN: tga, TOTLL: totll, CBBTCUSD: btc });
      setAllData(result);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
  }, []);

  // Filter by time range
  const filtered = useMemo(() => {
    if (!allData) return { impulse: [], level: [] };
    if (timeRange === "all") return allData;
    const now = new Date();
    const cut = new Date();
    if (timeRange === "1y") cut.setFullYear(now.getFullYear() - 1);
    else if (timeRange === "2y") cut.setFullYear(now.getFullYear() - 2);
    else if (timeRange === "5y") cut.setFullYear(now.getFullYear() - 5);
    else if (timeRange === "ytd") { cut.setMonth(0); cut.setDate(1); }
    const cutStr = cut.toISOString().slice(0, 10);
    return {
      impulse: allData.impulse.filter((d) => d.date >= cutStr),
      level: allData.level.filter((d) => d.date >= cutStr),
    };
  }, [allData, timeRange]);

  // Latest impulse data for stat cards
  const latest = useMemo(() => {
    if (!filtered.impulse.length) return null;
    return filtered.impulse[filtered.impulse.length - 1];
  }, [filtered]);

  // Thin impulse data for chart
  const impulseChartData = useMemo(() => {
    const d = filtered.impulse;
    if (d.length <= 200) return d;
    const step = Math.ceil(d.length / 150);
    return d.filter((_, i) => i % step === 0 || i === d.length - 1);
  }, [filtered]);

  // Level chart data with lead-shifted liquidity line
  const levelChartData = useMemo(() => {
    const d = filtered.level;
    if (!d.length) return [];

    // Thin if needed
    let thinned = d;
    if (d.length > 300) {
      const step = Math.ceil(d.length / 250);
      thinned = d.filter((_, i) => i % step === 0 || i === d.length - 1);
    }

    // Shift net liquidity forward by leadWeeks
    // leadWeeks * 7 days forward = "liquidity leads BTC by N weeks"
    const shiftDays = leadWeeks * 7;
    return thinned.map((row) => {
      const shiftedDate = new Date(row.date);
      shiftedDate.setDate(shiftedDate.getDate() + shiftDays);
      return {
        ...row,
        // Keep original date for x-axis (aligned to BTC)
        // But show the net liquidity value from N weeks earlier
        // We reverse this: for each BTC date, find the liquidity value from N weeks ago
      };
    });
  }, [filtered, leadWeeks]);

  // Better approach: align on date, shift liquidity forward
  const levelChartAligned = useMemo(() => {
    const d = filtered.level;
    if (!d.length) return [];

    const shiftDays = leadWeeks * 7;

    // Create a map of date -> netLiquidity
    const liqMap = {};
    for (const row of d) {
      liqMap[row.date] = row.netLiquidity;
    }

    // For each row, look up the net liquidity from shiftDays ago
    // This makes the liquidity line "lead" — showing where liquidity WAS
    // N weeks before the current BTC price
    const result = [];
    for (const row of d) {
      const pastDate = new Date(row.date);
      pastDate.setDate(pastDate.getDate() - shiftDays);
      const pastStr = pastDate.toISOString().slice(0, 10);

      // Find closest date in data
      let closestLiq = null;
      let bestDiff = Infinity;
      for (const r of d) {
        const diff = Math.abs(new Date(r.date) - new Date(pastStr));
        if (diff < bestDiff) {
          bestDiff = diff;
          closestLiq = r.netLiquidity;
        }
        if (r.date > pastStr && bestDiff < 8 * 86400000) break; // close enough
      }

      result.push({
        date: row.date,
        netLiquidity: closestLiq,
        btc: row.btc,
        walcl: row.walcl,
        tga: row.tga,
        totll: row.totll,
      });
    }

    // Thin if needed
    if (result.length > 250) {
      const step = Math.ceil(result.length / 200);
      return result.filter((_, i) => i % step === 0 || i === result.length - 1);
    }
    return result;
  }, [filtered, leadWeeks]);

  /* ── loading ── */
  if (loading) {
    return (
      <div style={{
        minHeight: "100vh",
        background: "linear-gradient(170deg, #0B0F14 0%, #131A24 50%, #0B0F14 100%)",
        display: "flex", alignItems: "center", justifyContent: "center",
        fontFamily: "'IBM Plex Mono', monospace", color: "#5A6B7D",
      }}>
        <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700&family=DM+Sans:wght@500;700&display=swap" rel="stylesheet" />
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 20, marginBottom: 12, animation: "pulse 1.5s infinite" }}>◈</div>
          <div style={{ fontSize: 12 }}>Fetching WALCL · WTREGEN · TOTLL · CBBTCUSD</div>
          <style>{`@keyframes pulse{0%,100%{opacity:.3}50%{opacity:1}}`}</style>
        </div>
      </div>
    );
  }

  /* ── error ── */
  if (error) {
    return (
      <div style={{
        minHeight: "100vh", background: "#0B0F14",
        display: "flex", alignItems: "center", justifyContent: "center",
        fontFamily: "'IBM Plex Mono', monospace",
      }}>
        <div style={{ color: "#EF5350", fontSize: 13, textAlign: "center" }}>
          <div style={{ marginBottom: 12 }}>Error: {error}</div>
          <button onClick={() => { setError(null); fetchAll(); }} style={{
            background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)",
            color: "#8899AA", padding: "10px 24px", borderRadius: 6, cursor: "pointer",
            fontFamily: "'IBM Plex Mono', monospace", fontSize: 12,
          }}>Try Again</button>
        </div>
      </div>
    );
  }

  if (!allData?.impulse?.length) return null;

  const compositeColor = latest?.composite >= 0 ? "#66BB6A" : "#EF5350";
  const ranges = [
    { key: "ytd", label: "YTD" },
    { key: "1y", label: "1Y" },
    { key: "2y", label: "2Y" },
    { key: "5y", label: "5Y" },
    { key: "all", label: "MAX" },
  ];

  /* ══════ DASHBOARD ══════ */
  return (
    <div style={{
      minHeight: "100vh",
      background: "linear-gradient(170deg, #0B0F14 0%, #131A24 50%, #0B0F14 100%)",
      fontFamily: "'IBM Plex Mono', monospace",
      padding: "28px 24px", boxSizing: "border-box",
    }}>
      <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700&family=DM+Sans:wght@500;700&display=swap" rel="stylesheet" />

      {/* ── Header ── */}
      <div style={{ marginBottom: 24, display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 14 }}>
        <div>
          <div style={{ fontSize: 20, fontWeight: 700, color: "#E2E8EE", fontFamily: "'DM Sans', sans-serif", marginBottom: 3 }}>
            Liquidity Monitor
          </div>
          <div style={{ fontSize: 11, color: "#4D5D6D" }}>
            Fed BS − TGA + Loans &amp; Leases &nbsp;|&nbsp; Last: {latest?.date}
          </div>
        </div>
        <div style={{ display: "flex", gap: 5, alignItems: "center", flexWrap: "wrap" }}>
          {ranges.map((r) => (
            <button key={r.key} onClick={() => setTimeRange(r.key)} style={{
              background: timeRange === r.key ? "rgba(79,195,247,0.12)" : "transparent",
              border: `1px solid ${timeRange === r.key ? "#4FC3F7" : "rgba(255,255,255,0.08)"}`,
              color: timeRange === r.key ? "#4FC3F7" : "#5A6B7D",
              padding: "5px 11px", borderRadius: 5, cursor: "pointer",
              fontSize: 11, fontFamily: "'IBM Plex Mono', monospace", fontWeight: 600,
            }}>{r.label}</button>
          ))}
          <button onClick={() => setShowBTC(!showBTC)} style={{
            background: showBTC ? "rgba(247,147,26,0.1)" : "transparent",
            border: `1px solid ${showBTC ? "#F7931A" : "rgba(255,255,255,0.08)"}`,
            color: showBTC ? "#F7931A" : "#5A6B7D",
            padding: "5px 11px", borderRadius: 5, cursor: "pointer",
            fontSize: 11, fontFamily: "'IBM Plex Mono', monospace", fontWeight: 600, marginLeft: 4,
          }}>₿</button>
        </div>
      </div>

      {/* ── Stat Cards ── */}
      <div style={{ display: "flex", gap: 10, marginBottom: 24, flexWrap: "wrap" }}>
        <StatCard
          label="Composite Impulse"
          value={fmt(latest?.composite)}
          sub="4-week net change"
          color={compositeColor}
        />
        <StatCard
          label="Δ Fed BS"
          value={fmt(latest?.dBS)}
          color="#4FC3F7"
          sub={`$${(latest?._walcl / 1e6).toFixed(2)}T total`}
        />
        <StatCard
          label="TGA Spend"
          value={fmt(latest?.dTGA)}
          color="#FF8A65"
          sub={`$${(latest?._tga / 1e3).toFixed(0)}B in TGA`}
        />
        <StatCard
          label="Δ Loans"
          value={fmt(latest?.dLoans)}
          color="#AED581"
          sub={`$${(latest?._totll / 1e6).toFixed(1)}T total`}
        />
        {showBTC && latest?.btc != null && (
          <StatCard label="Bitcoin" value={fmtBTC(latest.btc)} color="#F7931A" />
        )}
      </div>

      {/* ═══════════════════════════════════════════ */}
      {/* ── CHART 1: IMPULSE (stacked bars) ──────── */}
      {/* ═══════════════════════════════════════════ */}
      <div style={{
        background: "rgba(255,255,255,0.015)",
        border: "1px solid rgba(255,255,255,0.05)",
        borderRadius: 12, padding: "20px 12px 12px",
        marginBottom: 20,
      }}>
        <div style={{ fontSize: 10, color: "#4D5D6D", marginBottom: 14, marginLeft: 8, letterSpacing: "0.08em", textTransform: "uppercase" }}>
          4-Week Impulse: Component Bars + Composite Line{showBTC ? " + Bitcoin" : ""}
        </div>
        <ResponsiveContainer width="100%" height={360}>
          <ComposedChart data={impulseChartData} stackOffset="sign" margin={{ top: 5, right: showBTC ? 55 : 15, left: 8, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.035)" />
            <XAxis
              dataKey="date" tickFormatter={fmtDate}
              tick={{ fill: "#4D5D6D", fontSize: 10, fontFamily: "'IBM Plex Mono'" }}
              stroke="rgba(255,255,255,0.05)"
              interval={Math.ceil(impulseChartData.length / 10)}
            />
            <YAxis
              yAxisId="impulse" tickFormatter={fmtAxis}
              tick={{ fill: "#4D5D6D", fontSize: 10, fontFamily: "'IBM Plex Mono'" }}
              stroke="rgba(255,255,255,0.05)" width={60}
            />
            {showBTC && (
              <YAxis
                yAxisId="btc" orientation="right"
                tickFormatter={(v) => v >= 1000 ? (v / 1000).toFixed(0) + "K" : v}
                tick={{ fill: "#F7931A", fontSize: 10, fontFamily: "'IBM Plex Mono'", opacity: 0.5 }}
                stroke="rgba(247,147,26,0.12)" width={50}
              />
            )}
            <Tooltip content={<ImpulseTooltip />} />
            <ReferenceLine yAxisId="impulse" y={0} stroke="rgba(255,255,255,0.12)" strokeDasharray="4 4" />

            <Bar yAxisId="impulse" dataKey="dBS" stackId="impulse" fill="#4FC3F7" fillOpacity={0.65} name="Δ Fed BS" />
            <Bar yAxisId="impulse" dataKey="dTGA" stackId="impulse" fill="#FF8A65" fillOpacity={0.65} name="TGA Spend" />
            <Bar yAxisId="impulse" dataKey="dLoans" stackId="impulse" fill="#AED581" fillOpacity={0.65} name="Δ Loans" />

            <Line yAxisId="impulse" dataKey="composite" stroke="#E2E8EE" strokeWidth={2} dot={false} name="Composite" />

            {showBTC && (
              <Line
                yAxisId="btc" dataKey="btc" stroke="#F7931A" strokeWidth={1.5}
                dot={false} name="Bitcoin" strokeDasharray="4 2" opacity={0.75} connectNulls
              />
            )}
          </ComposedChart>
        </ResponsiveContainer>
        <div style={{
          display: "flex", justifyContent: "center", gap: 18, flexWrap: "wrap",
          fontSize: 10, color: "#4D5D6D", marginTop: 8,
        }}>
          <span><span style={{ color: "#4FC3F7" }}>■</span> Δ Fed BS</span>
          <span><span style={{ color: "#FF8A65" }}>■</span> −Δ TGA (spend)</span>
          <span><span style={{ color: "#AED581" }}>■</span> Δ Loans &amp; Leases</span>
          <span><span style={{ color: "#E2E8EE" }}>━</span> Composite</span>
          {showBTC && <span><span style={{ color: "#F7931A" }}>┅</span> Bitcoin</span>}
        </div>
      </div>

      {/* ═══════════════════════════════════════════ */}
      {/* ── CHART 2: LEVEL (Raoul-style) ─────────── */}
      {/* ═══════════════════════════════════════════ */}
      <div style={{
        background: "rgba(255,255,255,0.015)",
        border: "1px solid rgba(255,255,255,0.05)",
        borderRadius: 12, padding: "20px 12px 12px",
      }}>
        <div style={{
          display: "flex", justifyContent: "space-between", alignItems: "center",
          marginBottom: 14, marginLeft: 8, marginRight: 8, flexWrap: "wrap", gap: 10,
        }}>
          <div style={{ fontSize: 10, color: "#4D5D6D", letterSpacing: "0.08em", textTransform: "uppercase" }}>
            Net Liquidity Level (Fed BS − TGA + Loans) — {leadWeeks}-Week Lead
            {showBTC ? " vs Bitcoin" : ""}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 10, color: "#5A6B7D" }}>Lead:</span>
            <input
              type="range"
              min={0}
              max={20}
              value={leadWeeks}
              onChange={(e) => setLeadWeeks(parseInt(e.target.value))}
              style={{
                width: 100,
                accentColor: "#81D4FA",
                cursor: "pointer",
              }}
            />
            <span style={{
              fontSize: 11, color: "#81D4FA", fontWeight: 600,
              fontFamily: "'IBM Plex Mono', monospace",
              minWidth: 50,
            }}>{leadWeeks} wks</span>
          </div>
        </div>

        <ResponsiveContainer width="100%" height={420}>
          <ComposedChart data={levelChartAligned} margin={{ top: 5, right: showBTC ? 55 : 15, left: 8, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.035)" />
            <XAxis
              dataKey="date" tickFormatter={fmtDate}
              tick={{ fill: "#4D5D6D", fontSize: 10, fontFamily: "'IBM Plex Mono'" }}
              stroke="rgba(255,255,255,0.05)"
              interval={Math.ceil(levelChartAligned.length / 10)}
            />
            <YAxis
              yAxisId="level"
              tickFormatter={(v) => "$" + (v / 1e6).toFixed(1) + "T"}
              tick={{ fill: "#81D4FA", fontSize: 10, fontFamily: "'IBM Plex Mono'" }}
              stroke="rgba(255,255,255,0.05)" width={70}
              domain={["auto", "auto"]}
            />
            {showBTC && (
              <YAxis
                yAxisId="btc" orientation="right"
                tickFormatter={(v) => v >= 1000 ? (v / 1000).toFixed(0) + "K" : v}
                tick={{ fill: "#F7931A", fontSize: 10, fontFamily: "'IBM Plex Mono'", opacity: 0.6 }}
                stroke="rgba(247,147,26,0.12)" width={55}
              />
            )}
            <Tooltip content={<LevelTooltip />} />

            <Area
              yAxisId="level"
              dataKey="netLiquidity"
              stroke="#81D4FA"
              strokeWidth={2}
              fill="url(#liquidityGradient)"
              fillOpacity={0.15}
              dot={false}
              name="Net Liquidity"
              connectNulls
            />

            {showBTC && (
              <Line
                yAxisId="btc" dataKey="btc" stroke="#F7931A" strokeWidth={2}
                dot={false} name="Bitcoin" connectNulls opacity={0.9}
              />
            )}

            <defs>
              <linearGradient id="liquidityGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#81D4FA" stopOpacity={0.3} />
                <stop offset="95%" stopColor="#81D4FA" stopOpacity={0} />
              </linearGradient>
            </defs>
          </ComposedChart>
        </ResponsiveContainer>

        <div style={{
          display: "flex", justifyContent: "center", gap: 20, flexWrap: "wrap",
          fontSize: 10, color: "#4D5D6D", marginTop: 8,
        }}>
          <span><span style={{ color: "#81D4FA" }}>━</span> Net Liquidity ({leadWeeks}wk lead)</span>
          {showBTC && <span><span style={{ color: "#F7931A" }}>━</span> Bitcoin</span>}
          <span style={{ color: "#3D4D5D" }}>TGA ↓ = Liquidity ↑</span>
        </div>
      </div>

      {/* ── Footer ── */}
      <div style={{ textAlign: "center", fontSize: 10, color: "#3A4A5A", marginTop: 16 }}>
        FRED: WALCL · WTREGEN · TOTLL · CBBTCUSD &nbsp;|&nbsp; Impulse: post-COVID &nbsp;|&nbsp; Level: 2014+ &nbsp;|&nbsp; TGA drawdown = liquidity injection
      </div>
    </div>
  );
}
