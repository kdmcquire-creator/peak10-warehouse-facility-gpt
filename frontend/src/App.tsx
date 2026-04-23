import React, { useEffect, useMemo, useState } from 'react';
import {
  ResponsiveContainer, AreaChart, Area, LineChart, Line, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ReferenceLine
} from 'recharts';

type TabStatus = { name: string; found: boolean };
type ModelInfo = {
  model_id: string;
  file_name: string;
  notes: string[];
  tabs: TabStatus[];
  month_count: number;
  first_month?: string;
  last_month?: string;
};

type Inputs = {
  horizon_months: number;
  initial_debt: number;
  purchase_discount_rate: number;
  acq_frequency_months: number;
  first_acq_month: number;
  size_multiple_a: number;
  size_multiple_b: number;
  alternate_size: boolean;
  acq_ltv: number;
  acq_fee_pct: number;
  allow_equity_plug: boolean;
  close_test_ltv: number;
  close_test_dscr: number;
  target_dscr: number;
  sweep_dscr_trigger: number;
  sweep_ltv_trigger: number;
  abs_target_ltv: number;
  abs_target_dscr: number;
  spread: number;
  mgmt_fee: number;
  availability_months: number;
  price_stress: number;
};

type ResultRow = {
  month: number;
  date: string;
  debt: number;
  pv10: number;
  dscr: number;
  ltv: number;
  fcf: number;
  opinc: number;
  capex: number;
  hedge_payoff: number;
  amort: number;
  free_cash: number;
  equity_cumulative: number;
  acquisition_event: boolean;
  equity_plug: number;
  asset_units: number;
  abs_eligible: boolean;
  sofr?: number | null;
};

type AegisCurveRow = { product_code?: string | null; date?: string | null; price?: number | null; is_forward?: boolean };
type AegisCurveResponse = { as_of_date: string; product_codes: string; rows: AegisCurveRow[] };

type RunResponse = {
  summary: {
    month_one_pv10: number;
    ending_debt: number;
    ending_dscr: number;
    ending_ltv: number;
    total_equity: number;
    sweeps: number;
    ending_assets: number;
    reached_200: number | null;
    reached_250: number | null;
    reached_300: number | null;
    final_abs_eligible: boolean;
  };
  results: ResultRow[];
};

const API = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000';
const COLORS = {
  debt: '#0f172a',
  pv10: '#2563eb',
  dscr: '#16a34a',
  ltv: '#dc2626',
  fcf: '#7c3aed',
  amort: '#ea580c',
  equityPlug: '#0891b2',
  sweep: '#e11d48',
  hedge: '#ca8a04',
  freeCash: '#22c55e',
  abs: '#14b8a6',
  downside: '#b91c1c',
  upside: '#0f766e',
  threshold: '#64748b',
};

const fmtMoney = (n: number) => {
  if (!Number.isFinite(n)) return '-';
  if (Math.abs(n) >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}MM`;
  return `$${n.toFixed(0)}`;
};
const fmtPct = (n: number) => `${(n * 100).toFixed(1)}%`;
const fmtX = (n: number) => `${n.toFixed(2)}x`;

function MetricCard({ title, value, subtext }: { title: string; value: string; subtext?: string }) {
  return (
    <div className="card metric-card">
      <div className="metric-title">{title}</div>
      <div className="metric-value">{value}</div>
      {subtext ? <div className="metric-sub">{subtext}</div> : null}
    </div>
  );
}

function UploadCard({ title, description, status }: { title: string; description: string; status: string }) {
  return (
    <div className="card upload-card">
      <div className="upload-title">{title}</div>
      <div className="upload-desc">{description}</div>
      <div className="badge">{status}</div>
    </div>
  );
}

export default function App() {
  const [tab, setTab] = useState<'performance'|'liquidity'|'takeout'|'workflow'>('performance');
  const [modelInfo, setModelInfo] = useState<ModelInfo | null>(null);
  const [runData, setRunData] = useState<RunResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [apiError, setApiError] = useState<string>('');
  const [stripSource, setStripSource] = useState<'uploaded'|'aegis'>('uploaded');
  const [aegisCurves, setAegisCurves] = useState<AegisCurveResponse | null>(null);
  const [aegisStatus, setAegisStatus] = useState<string>('Not checked');
  const [inputs, setInputs] = useState<Inputs>({
    horizon_months: 60,
    initial_debt: 26_500_000,
    purchase_discount_rate: 0.18,
    acq_frequency_months: 2,
    first_acq_month: 2,
    size_multiple_a: 1,
    size_multiple_b: 2,
    alternate_size: true,
    acq_ltv: 0.70,
    acq_fee_pct: 0.01,
    allow_equity_plug: true,
    close_test_ltv: 0.70,
    close_test_dscr: 1.25,
    target_dscr: 1.25,
    sweep_dscr_trigger: 1.20,
    sweep_ltv_trigger: 0.80,
    abs_target_ltv: 0.65,
    abs_target_dscr: 1.25,
    spread: 0.035,
    mgmt_fee: 0.02,
    availability_months: 12,
    price_stress: 0,
  });

  const set = <K extends keyof Inputs>(key: K, value: Inputs[K]) => setInputs(prev => ({ ...prev, [key]: value }));

  async function uploadWorkbook(file: File) {
    setLoading(true);
    setApiError('');
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch(`${API}/api/upload-model`, { method: 'POST', body: fd });
      if (!res.ok) throw new Error(`Upload failed (${res.status})`);
      const data = await res.json();
      setModelInfo(data);
    } catch (e) {
      setApiError(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setLoading(false);
    }
  }

  async function rerun() {
    if (!modelInfo) return;
    setLoading(true);
    setApiError('');
    try {
      const res = await fetch(`${API}/api/run-model`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model_id: modelInfo.model_id, inputs }),
      });
      if (!res.ok) throw new Error(`Run failed (${res.status})`);
      const data = await res.json();
      setRunData(data);
    } catch (e) {
      setApiError(e instanceof Error ? e.message : 'Run failed');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (modelInfo) void rerun();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelInfo, inputs]);

  async function pingAegis() {
    try {
      const res = await fetch(`${API}/api/aegis/ping`);
      const data = await res.json();
      setAegisStatus(data?.has_creds ? 'Configured' : 'Missing backend env vars');
    } catch (e) {
      setAegisStatus('Unavailable');
    }
  }

  async function fetchAegisCurves() {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const end = new Date(); end.setMonth(end.getMonth() + 12);
      const endStr = end.toISOString().slice(0, 10);
      const res = await fetch(`${API}/api/aegis/combined-curves?as_of_date=${today}&product_codes=R,H&start_date=${today}&end_date=${endStr}`);
      if (!res.ok) throw new Error(`Aegis curve fetch failed (${res.status})`);
      const data = await res.json();
      setAegisCurves(data);
      setStripSource('aegis');
    } catch (e) {
      setApiError(e instanceof Error ? e.message : 'Aegis fetch failed');
    }
  }

  const scenarioCompare = useMemo(() => {
    if (!runData?.results?.length) return [];
    return [1, 6, 12, Math.min(runData.results.length, 24)].map((m) => {
      const row = runData.results[Math.max(0, m - 1)];
      return {
        month: row.month,
        base: row.debt,
        downside: row.debt * 1.08,
        upside: row.debt * 0.92,
      };
    });
  }, [runData]);

  const targets = runData ? [
    { label: '$200mm', month: runData.summary.reached_200 },
    { label: '$250mm', month: runData.summary.reached_250 },
    { label: '$300mm', month: runData.summary.reached_300 },
  ] : [];

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <div className="headline">
            <h1>Peak 10 Facility Dashboard</h1>
            <span className="badge dark">React + FastAPI</span>
            <span className="badge">Current base: PDP ResCat only</span>
          </div>
          <p>
            Functional local app using workbook upload, parsed PDP monthly cash flow, stressed strip, SOFR curve,
            current hedges, and a facility engine that replaces the old perpetuity-style PV proxy.
          </p>
        </div>
        <div className="top-actions">
          <button className="btn ghost" onClick={() => set('price_stress', -0.15)}>Stress -15%</button>
          <button className="btn ghost" onClick={() => set('price_stress', -0.30)}>Stress -30%</button>
          <button className="btn" onClick={() => { set('price_stress', 0); }}>Reset Base</button>
        </div>
      </header>

      <div className="grid cards4">
        <UploadCard title="Workbook upload" description={modelInfo ? modelInfo.file_name : 'Upload the corporate model workbook'} status={modelInfo ? 'Loaded' : 'Pending'} />
        <UploadCard title="Backend parser" description="CF / Strip Pricing / 1-month Term SOFR / GRC Hedges / Brown Pony Hedges" status="Active" />
        <UploadCard title="Facility engine" description="PV10, sweeps, acquisition gating, ABS screens" status={runData ? 'Running' : 'Waiting'} />
        <UploadCard title="Frontend workflow" description="Controls, charts, same-UI iteration, file-driven recalc" status="Active" />
      </div>

      <div className="grid metrics6">
        <MetricCard title="Month 1 PV10" value={fmtMoney(runData?.summary.month_one_pv10 ?? 0)} subtext="Discounted remaining CF" />
        <MetricCard title="Ending Debt" value={fmtMoney(runData?.summary.ending_debt ?? 0)} subtext="Facility debt outstanding" />
        <MetricCard title="Ending DSCR" value={fmtX(runData?.summary.ending_dscr ?? 0)} subtext={`ABS target ${fmtX(inputs.abs_target_dscr)}`} />
        <MetricCard title="Ending LTV" value={fmtPct(runData?.summary.ending_ltv ?? 0)} subtext={`ABS target ${fmtPct(inputs.abs_target_ltv)}`} />
        <MetricCard title="Total Equity" value={fmtMoney(runData?.summary.total_equity ?? 0)} subtext="Acq equity plus cures" />
        <MetricCard title="Asset Units" value={(runData?.summary.ending_assets ?? 0).toFixed(1)} subtext={`Sweep months ${runData?.summary.sweeps ?? 0}`} />
      </div>

      <div className="grid layout">
        <aside className="card controls">
          <h3>Upload and Controls</h3>
          <label className="file-upload">
            <span>Upload workbook</span>
            <input type="file" accept=".xlsx,.xlsm,.xls" onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void uploadWorkbook(f);
            }} />
          </label>
          {modelInfo ? (
            <div className="small-block">
              <div><strong>Months:</strong> {modelInfo.month_count}</div>
              <div><strong>Range:</strong> {modelInfo.first_month} to {modelInfo.last_month}</div>
              <div><strong>Tabs:</strong> {modelInfo.tabs.filter(t => t.found).map(t => t.name).join(', ')}</div>
            </div>
          ) : null}

          <label>Price stress
            <input type="range" min="-0.4" max="0.2" step="0.05" value={inputs.price_stress} onChange={e => set('price_stress', Number(e.target.value))} />
            <span>{(inputs.price_stress * 100).toFixed(0)}%</span>
          </label>
          <label>Acquisition frequency (months)
            <input type="number" value={inputs.acq_frequency_months} onChange={e => set('acq_frequency_months', Number(e.target.value))} />
          </label>
          <label>Size multiple A
            <input type="number" value={inputs.size_multiple_a} onChange={e => set('size_multiple_a', Number(e.target.value))} />
          </label>
          <label>Size multiple B
            <input type="number" value={inputs.size_multiple_b} onChange={e => set('size_multiple_b', Number(e.target.value))} />
          </label>
          <label>Purchase PDP discount rate
            <input type="number" step="0.01" value={inputs.purchase_discount_rate} onChange={e => set('purchase_discount_rate', Number(e.target.value))} />
          </label>
          <label>Acquisition LTV
            <input type="number" step="0.01" value={inputs.acq_ltv} onChange={e => set('acq_ltv', Number(e.target.value))} />
          </label>
          <label>Target DSCR
            <input type="number" step="0.01" value={inputs.target_dscr} onChange={e => set('target_dscr', Number(e.target.value))} />
          </label>
          <label>Sweep LTV trigger
            <input type="number" step="0.01" value={inputs.sweep_ltv_trigger} onChange={e => set('sweep_ltv_trigger', Number(e.target.value))} />
          </label>
          <label>ABS target LTV
            <input type="number" step="0.01" value={inputs.abs_target_ltv} onChange={e => set('abs_target_ltv', Number(e.target.value))} />
          </label>
          <label>ABS target DSCR
            <input type="number" step="0.01" value={inputs.abs_target_dscr} onChange={e => set('abs_target_dscr', Number(e.target.value))} />
          </label>
          <label className="toggle">
            <input type="checkbox" checked={inputs.alternate_size} onChange={e => set('alternate_size', e.target.checked)} />
            <span>Alternate acquisition sizes</span>
          </label>
          <label className="toggle">
            <input type="checkbox" checked={inputs.allow_equity_plug} onChange={e => set('allow_equity_plug', e.target.checked)} />
            <span>Allow equity plug</span>
          </label>
          <button className="btn full" disabled={!modelInfo || loading} onClick={() => void rerun()}>
            {loading ? 'Running...' : 'Recalculate'}
          </button>
          {apiError ? <div className="error">{apiError}</div> : null}
        </aside>

        <main className="stack">
          <div className="tabs">
            <button className={tab==='performance'?'tab active':'tab'} onClick={() => setTab('performance')}>Performance</button>
            <button className={tab==='liquidity'?'tab active':'tab'} onClick={() => setTab('liquidity')}>Liquidity</button>
            <button className={tab==='takeout'?'tab active':'tab'} onClick={() => setTab('takeout')}>ABS Takeout</button>
            <button className={tab==='workflow'?'tab active':'tab'} onClick={() => setTab('workflow')}>Workflow</button>
          </div>

          {tab === 'performance' && (
            <>
              <div className="card chart">
                <h3>Debt and PV10</h3>
                <ResponsiveContainer width="100%" height={320}>
                  <AreaChart data={runData?.results ?? []}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="month" />
                    <YAxis tickFormatter={fmtMoney} />
                    <Tooltip formatter={(v: number) => fmtMoney(v)} />
                    <Legend />
                    <Area type="monotone" dataKey="pv10" name="PV10 from remaining CF" fill={COLORS.pv10} stroke={COLORS.pv10} fillOpacity={0.18} />
                    <Line type="monotone" dataKey="debt" name="Debt" stroke={COLORS.debt} strokeWidth={3} dot={false} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
              <div className="card chart">
                <h3>DSCR and LTV</h3>
                <ResponsiveContainer width="100%" height={320}>
                  <LineChart data={runData?.results ?? []}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="month" />
                    <YAxis yAxisId="left" domain={[0, 2.5]} />
                    <YAxis yAxisId="right" orientation="right" domain={[0, 1.2]} tickFormatter={(v: number) => `${(v*100).toFixed(0)}%`} />
                    <Tooltip />
                    <Legend />
                    <ReferenceLine yAxisId="left" y={inputs.sweep_dscr_trigger} stroke={COLORS.threshold} strokeDasharray="4 4" />
                    <ReferenceLine yAxisId="left" y={inputs.abs_target_dscr} stroke={COLORS.dscr} strokeDasharray="2 6" />
                    <ReferenceLine yAxisId="right" y={inputs.sweep_ltv_trigger} stroke={COLORS.threshold} strokeDasharray="4 4" />
                    <ReferenceLine yAxisId="right" y={inputs.abs_target_ltv} stroke={COLORS.ltv} strokeDasharray="2 6" />
                    <Line yAxisId="left" type="monotone" dataKey="dscr" name="DSCR" stroke={COLORS.dscr} strokeWidth={3} dot={false} />
                    <Line yAxisId="right" type="monotone" dataKey="ltv" name="LTV" stroke={COLORS.ltv} strokeWidth={3} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </>
          )}

          {tab === 'liquidity' && (
            <>
              <div className="grid cols2">
                <div className="card chart">
                  <h3>FCF, Amortization, and Equity Plug</h3>
                  <ResponsiveContainer width="100%" height={300}>
                    <BarChart data={runData?.results ?? []}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="month" />
                      <YAxis tickFormatter={fmtMoney} />
                      <Tooltip formatter={(v: number) => fmtMoney(v)} />
                      <Legend />
                      <Bar dataKey="fcf" name="FCF" fill={COLORS.fcf} />
                      <Bar dataKey="amort" name="Amortization" fill={COLORS.amort} />
                      <Bar dataKey="equity_plug" name="Equity Plug" fill={COLORS.equityPlug} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <div className="card chart">
                  <h3>Hedge Effect and Free Cash</h3>
                  <ResponsiveContainer width="100%" height={300}>
                    <LineChart data={runData?.results ?? []}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="month" />
                      <YAxis tickFormatter={fmtMoney} />
                      <Tooltip formatter={(v: number) => fmtMoney(v)} />
                      <Legend />
                      <Line type="monotone" dataKey="hedge_payoff" name="Hedge Payoff" stroke={COLORS.hedge} strokeWidth={3} dot={false} />
                      <Line type="monotone" dataKey="free_cash" name="Free Cash" stroke={COLORS.freeCash} strokeWidth={3} dot={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </>
          )}

          {tab === 'takeout' && (
            <>
              <div className="card chart">
                <h3>ABS Eligibility Timeline</h3>
                <ResponsiveContainer width="100%" height={280}>
                  <AreaChart data={runData?.results?.map(r => ({ ...r, abs: r.abs_eligible ? 1 : 0 })) ?? []}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="month" />
                    <YAxis domain={[0, 1]} />
                    <Tooltip />
                    <Legend />
                    <Area type="stepAfter" dataKey="abs" name="ABS Eligible" fill={COLORS.abs} stroke={COLORS.abs} fillOpacity={0.35} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
              <div className="grid cols2">
                <div className="card">
                  <h3>Debt Scale Versus Takeout Targets</h3>
                  <div className="target-grid">
                    {targets.map(t => (
                      <div className="target-card" key={t.label}>
                        <div className="target-label">{t.label}</div>
                        <div className="target-value">{t.month ? `Month ${t.month}` : 'Not reached'}</div>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="card chart">
                  <h3>Scenario Comparison</h3>
                  <ResponsiveContainer width="100%" height={240}>
                    <LineChart data={scenarioCompare}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="month" />
                      <YAxis tickFormatter={fmtMoney} />
                      <Tooltip formatter={(v: number) => fmtMoney(v)} />
                      <Legend />
                      <Line type="monotone" dataKey="base" name="Base" stroke={COLORS.pv10} strokeWidth={3} dot={false} />
                      <Line type="monotone" dataKey="downside" name="Downside" stroke={COLORS.downside} strokeWidth={3} dot={false} />
                      <Line type="monotone" dataKey="upside" name="Upside" stroke={COLORS.upside} strokeWidth={3} dot={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </>
          )}

          {tab === 'workflow' && (
            <div className="grid cols2">
              <div className="card">
                <h3>Source Mapping</h3>
                <div className="workflow-item">CF tab → PDP ResCat current base using <code>RSV_CAT == 1PDP</code> and <code>SCENARIO == PK10</code>.</div>
                <div className="workflow-item">Strip Pricing → stressed WTI / HH / Waha by month-end.</div>
                <div className="workflow-item">1-month Term SOFR → carry curve by month-end.</div>
                <div className="workflow-item">GRC and Brown Pony hedges → monthly existing hedge payoff.</div>
              </div>
              <div className="card">
                <h3>Engine Notes</h3>
                <div className="workflow-item">Month-one PV10 uses discounted remaining monthly cash flow rather than <code>FCF / 10%</code>.</div>
                <div className="workflow-item">New acquisitions are valued at the user-selected PDP discount rate at the month of closing.</div>
                <div className="workflow-item">Sweeps trigger on post-availability, DSCR breach, or LTV breach.</div>
                <div className="workflow-item">ABS readiness is screened at user-defined LTV and DSCR targets.</div>
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
