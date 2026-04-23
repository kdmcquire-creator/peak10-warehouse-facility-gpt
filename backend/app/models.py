from pydantic import BaseModel, Field
from typing import List, Optional

class WorkbookTabStatus(BaseModel):
    name: str
    found: bool

class BaseMonthlyRow(BaseModel):
    outdate: str
    gr_oil: float = 0.0
    gr_gas: float = 0.0
    n_oil: float = 0.0
    n_gas: float = 0.0
    n_ngl: float = 0.0
    n_tot_rev: float = 0.0
    opinc: float = 0.0
    n_capex: float = 0.0
    fcf_unhedged: float = 0.0
    wti: Optional[float] = None
    hh: Optional[float] = None
    waha: Optional[float] = None
    sofr: Optional[float] = None
    hedge_payoff: float = 0.0
    fcf_hedged: float = 0.0

class HedgePosition(BaseModel):
    entity: Optional[str] = None
    underlying: Optional[str] = None
    trade_type: Optional[str] = None
    direction: Optional[str] = None
    flavor: Optional[str] = None
    strike: Optional[float] = None
    quantity: Optional[float] = None
    contract_end_date: Optional[str] = None

class ParsedWorkbook(BaseModel):
    model_id: str
    file_name: str
    tabs: List[WorkbookTabStatus]
    notes: List[str] = Field(default_factory=list)
    month_count: int = 0
    first_month: Optional[str] = None
    last_month: Optional[str] = None
    base_monthly: List[BaseMonthlyRow] = Field(default_factory=list)
    hedges: List[HedgePosition] = Field(default_factory=list)

class EngineInputs(BaseModel):
    horizon_months: int = 60
    initial_debt: float = 26_500_000
    purchase_discount_rate: float = 0.18
    acq_frequency_months: int = 2
    first_acq_month: int = 2
    size_multiple_a: float = 1.0
    size_multiple_b: float = 2.0
    alternate_size: bool = True
    acq_ltv: float = 0.70
    acq_fee_pct: float = 0.01
    allow_equity_plug: bool = True
    close_test_ltv: float = 0.70
    close_test_dscr: float = 1.25
    target_dscr: float = 1.25
    sweep_dscr_trigger: float = 1.20
    sweep_ltv_trigger: float = 0.80
    abs_target_ltv: float = 0.65
    abs_target_dscr: float = 1.25
    spread: float = 0.035
    mgmt_fee: float = 0.02
    availability_months: int = 12
    price_stress: float = 0.0

class RunModelRequest(BaseModel):
    model_id: str
    inputs: EngineInputs

class ResultRow(BaseModel):
    month: int
    date: str
    debt: float
    pv10: float
    dscr: float
    ltv: float
    fcf: float
    opinc: float
    capex: float
    hedge_payoff: float
    amort: float
    free_cash: float
    equity_cumulative: float
    acquisition_event: bool
    equity_plug: float
    asset_units: float
    abs_eligible: bool
    sofr: Optional[float] = None

class ModelSummary(BaseModel):
    month_one_pv10: float
    ending_debt: float
    ending_dscr: float
    ending_ltv: float
    total_equity: float
    sweeps: int
    ending_assets: float
    reached_200: Optional[int] = None
    reached_250: Optional[int] = None
    reached_300: Optional[int] = None
    final_abs_eligible: bool

class ModelResponse(BaseModel):
    summary: ModelSummary
    results: List[ResultRow]


class AegisCurveRow(BaseModel):
    product_code: str | None = None
    date: str | None = None
    settlement_price: float | None = None
    forward_price: float | None = None
    price: float | None = None
    is_forward: bool = False

class AegisCurveResponse(BaseModel):
    as_of_date: str
    product_codes: str
    rows: List[AegisCurveRow] = Field(default_factory=list)
