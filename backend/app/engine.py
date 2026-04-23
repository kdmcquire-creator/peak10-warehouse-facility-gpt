import math
from typing import List, Dict
from .models import ParsedWorkbook, EngineInputs, ResultRow, ModelResponse, ModelSummary, HedgePosition

MONTHLY_PV10_RATE = math.pow(1.10, 1 / 12) - 1

def stress_market(row, price_stress: float) -> Dict[str, float]:
    return {
        "wti": float((row.wti or 0.0) * (1 + price_stress)),
        "hh": float((row.hh or 0.0) * (1 + price_stress)),
        "waha": float((row.waha or 0.0)),
    }

def calc_hedge_payoff(position: HedgePosition, market: Dict[str, float]) -> float:
    if position.underlying == "NYMEX WTI CMA":
        px = market.get("wti", 0.0)
    elif position.underlying == "NYMEX Henry Hub (LD)":
        px = market.get("hh", 0.0)
    elif position.underlying == "Waha Basis":
        px = market.get("waha", 0.0)
    else:
        return 0.0
    strike = float(position.strike or 0.0)
    qty = abs(float(position.quantity or 0.0))
    if position.trade_type == "Swaps":
        return (strike - px) * qty
    if position.trade_type == "Options" and position.flavor == "Put" and position.direction == "Buy":
        return max(strike - px, 0.0) * qty
    if position.trade_type == "Options" and position.flavor == "Call" and position.direction == "Sell":
        return -max(px - strike, 0.0) * qty
    return 0.0

def existing_row_fcf(row, hedges_by_month, price_stress: float) -> Dict[str, float]:
    stressed_unhedged = float(row.fcf_unhedged) * (1 + price_stress)
    market = stress_market(row, price_stress)
    hedge_payoff = sum(calc_hedge_payoff(h, market) for h in hedges_by_month.get(row.outdate, []))
    return {
        "fcf": stressed_unhedged + hedge_payoff,
        "hedge_payoff": hedge_payoff,
        "opinc": float(row.opinc) * (1 + price_stress),
        "capex": float(row.n_capex),
        "sofr": float(row.sofr or 0.0),
    }

def new_acq_row_fcf(row, price_stress: float) -> Dict[str, float]:
    stressed_unhedged = float(row.fcf_unhedged) * (1 + price_stress)
    return {
        "fcf": stressed_unhedged,
        "hedge_payoff": 0.0,
        "opinc": float(row.opinc) * (1 + price_stress),
        "capex": float(row.n_capex),
        "sofr": float(row.sofr or 0.0),
    }

def remaining_pv(parsed: ParsedWorkbook, start_index: int, multiple: float, price_stress: float, include_existing_hedges: bool) -> float:
    pv = 0.0
    hedge_by_month = {}
    if include_existing_hedges:
        for h in parsed.hedges:
            hedge_by_month.setdefault(h.contract_end_date, []).append(h)

    for i in range(start_index, len(parsed.base_monthly)):
        row = parsed.base_monthly[i]
        if include_existing_hedges:
            cf = existing_row_fcf(row, hedge_by_month, price_stress)["fcf"]
        else:
            cf = new_acq_row_fcf(row, price_stress)["fcf"]
        pv += (cf * multiple) / math.pow(1 + MONTHLY_PV10_RATE, i - start_index + 1)
    return max(0.0, pv)

def purchase_pv(parsed: ParsedWorkbook, multiple: float, price_stress: float, annual_discount_rate: float) -> float:
    monthly = math.pow(1 + annual_discount_rate, 1 / 12) - 1
    pv = 0.0
    for i, row in enumerate(parsed.base_monthly):
        cf = new_acq_row_fcf(row, price_stress)["fcf"]
        pv += (cf * multiple) / math.pow(1 + monthly, i + 1)
    return max(0.0, pv)

def run_model(parsed: ParsedWorkbook, inputs: EngineInputs) -> ModelResponse:
    horizon = min(inputs.horizon_months, len(parsed.base_monthly))
    hedge_by_month = {}
    for h in parsed.hedges:
        hedge_by_month.setdefault(h.contract_end_date, []).append(h)

    assets = [{"start_month": 1, "multiple": 1.0, "include_existing_hedges": True}]
    results: List[ResultRow] = []

    debt = inputs.initial_debt
    equity_cumulative = 0.0
    next_acq_month = inputs.first_acq_month
    reached_200 = None
    reached_250 = None
    reached_300 = None
    sweep_count = 0

    for month in range(1, horizon + 1):
        portfolio_fcf = 0.0
        portfolio_pv10 = 0.0
        opinc = 0.0
        capex = 0.0
        hedge_payoff = 0.0
        asset_units = 0.0

        for asset in assets:
            age = month - asset["start_month"]
            if age < 0 or age >= len(parsed.base_monthly):
                continue
            row = parsed.base_monthly[age]
            if asset["include_existing_hedges"]:
                vals = existing_row_fcf(row, hedge_by_month, inputs.price_stress)
                pv = remaining_pv(parsed, age, asset["multiple"], inputs.price_stress, True)
            else:
                vals = new_acq_row_fcf(row, inputs.price_stress)
                pv = remaining_pv(parsed, age, asset["multiple"], inputs.price_stress, False)

            portfolio_fcf += vals["fcf"] * asset["multiple"]
            opinc += vals["opinc"] * asset["multiple"]
            capex += vals["capex"] * asset["multiple"]
            hedge_payoff += vals["hedge_payoff"] * asset["multiple"]
            portfolio_pv10 += pv * asset["multiple"]
            asset_units += asset["multiple"]

        current_row = parsed.base_monthly[min(month - 1, len(parsed.base_monthly) - 1)]
        sofr = float(current_row.sofr or 0.0)
        stepups = (math.floor((month - inputs.availability_months - 1) / 6) + 1) if month > inputs.availability_months else 0
        spread = inputs.spread + (0.01 if month > inputs.availability_months else 0.0) + max(0, stepups - 1) * 0.005
        all_in_rate = sofr + spread

        mgmt_fee_monthly = debt * inputs.mgmt_fee / 12
        interest_monthly = debt * all_in_rate / 12
        target_debt_service = max(0.0, portfolio_fcf / inputs.target_dscr)
        scheduled_amort = max(0.0, target_debt_service - interest_monthly - mgmt_fee_monthly)

        pre_sweep_dscr = 99.0 if (interest_monthly + mgmt_fee_monthly + scheduled_amort) <= 0 else portfolio_fcf / (interest_monthly + mgmt_fee_monthly + scheduled_amort)
        pre_sweep_ltv = 99.0 if portfolio_pv10 <= 0 else debt / portfolio_pv10

        acquisition_event = False
        equity_plug = 0.0

        if month == next_acq_month:
            acquisition_event = True
            step_index = math.floor((month - inputs.first_acq_month) / inputs.acq_frequency_months) if inputs.acq_frequency_months > 0 else 0
            size_multiple = inputs.size_multiple_a
            if inputs.alternate_size:
                size_multiple = inputs.size_multiple_a if step_index % 2 == 0 else inputs.size_multiple_b

            acq_pv = purchase_pv(parsed, size_multiple, inputs.price_stress, inputs.purchase_discount_rate)
            acq_debt_candidate = acq_pv * inputs.acq_ltv
            acq_fcf = new_acq_row_fcf(parsed.base_monthly[0], inputs.price_stress)["fcf"] * size_multiple
            acq_fee = acq_pv * inputs.acq_fee_pct

            proforma_debt = max(0.0, debt - scheduled_amort) + acq_debt_candidate
            proforma_pv = portfolio_pv10 + remaining_pv(parsed, 0, size_multiple, inputs.price_stress, False)
            close_carry = proforma_debt * (all_in_rate + inputs.mgmt_fee)
            close_dscr = 99.0 if close_carry <= 0 else ((portfolio_fcf + acq_fcf) * 12) / close_carry
            close_ltv = 99.0 if proforma_pv <= 0 else proforma_debt / proforma_pv
            acq_equity = acq_pv - acq_debt_candidate + acq_fee

            passes = (
                close_ltv <= inputs.close_test_ltv and
                close_dscr >= inputs.close_test_dscr and
                pre_sweep_dscr >= inputs.sweep_dscr_trigger
            )

            if passes:
                assets.append({"start_month": month, "multiple": size_multiple, "include_existing_hedges": False})
                debt += acq_debt_candidate
                equity_cumulative += acq_equity
                next_acq_month += inputs.acq_frequency_months
            elif inputs.allow_equity_plug:
                debt_to_ltv = max(0.0, proforma_debt - proforma_pv * inputs.close_test_ltv)
                debt_to_dscr = max(0.0, proforma_debt - (((portfolio_fcf + acq_fcf) * 12) / (inputs.close_test_dscr * (all_in_rate + inputs.mgmt_fee))))
                equity_plug = max(debt_to_ltv, debt_to_dscr)
                assets.append({"start_month": month, "multiple": size_multiple, "include_existing_hedges": False})
                debt = max(0.0, debt - equity_plug + acq_debt_candidate)
                equity_cumulative += acq_equity + equity_plug
                next_acq_month += inputs.acq_frequency_months

        sweep = month > inputs.availability_months or pre_sweep_dscr < inputs.sweep_dscr_trigger or pre_sweep_ltv > inputs.sweep_ltv_trigger
        if sweep:
            sweep_count += 1
        cash_sweep = max(0.0, portfolio_fcf - interest_monthly - mgmt_fee_monthly) if sweep else 0.0
        amort = scheduled_amort + cash_sweep
        debt = max(0.0, debt - amort)
        free_cash = 0.0 if sweep else max(0.0, portfolio_fcf - interest_monthly - mgmt_fee_monthly - scheduled_amort)

        annual_carry = debt * (all_in_rate + inputs.mgmt_fee)
        abs_dscr = 99.0 if annual_carry <= 0 else (portfolio_fcf * 12) / annual_carry
        end_ltv = 99.0 if portfolio_pv10 <= 0 else debt / portfolio_pv10
        abs_eligible = end_ltv <= inputs.abs_target_ltv and abs_dscr >= inputs.abs_target_dscr

        if reached_200 is None and debt >= 200_000_000:
            reached_200 = month
        if reached_250 is None and debt >= 250_000_000:
            reached_250 = month
        if reached_300 is None and debt >= 300_000_000:
            reached_300 = month

        results.append(ResultRow(
            month=month,
            date=current_row.outdate,
            debt=debt,
            pv10=portfolio_pv10,
            dscr=abs_dscr,
            ltv=end_ltv,
            fcf=portfolio_fcf,
            opinc=opinc,
            capex=capex,
            hedge_payoff=hedge_payoff,
            amort=amort,
            free_cash=free_cash,
            equity_cumulative=equity_cumulative,
            acquisition_event=acquisition_event,
            equity_plug=equity_plug,
            asset_units=asset_units,
            abs_eligible=abs_eligible,
            sofr=sofr,
        ))

    last = results[-1] if results else None
    summary = ModelSummary(
        month_one_pv10=results[0].pv10 if results else 0.0,
        ending_debt=last.debt if last else 0.0,
        ending_dscr=last.dscr if last else 0.0,
        ending_ltv=last.ltv if last else 0.0,
        total_equity=last.equity_cumulative if last else 0.0,
        sweeps=sweep_count,
        ending_assets=last.asset_units if last else 0.0,
        reached_200=reached_200,
        reached_250=reached_250,
        reached_300=reached_300,
        final_abs_eligible=last.abs_eligible if last else False,
    )
    return ModelResponse(summary=summary, results=results)
