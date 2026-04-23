from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from .models import ParsedWorkbook, ModelResponse, RunModelRequest
from .parser import parse_workbook
from .engine import run_model
from .state import MODEL_STORE
from .aegis import ping as aegis_ping, entities as aegis_entities, combined_curves as aegis_combined_curves, normalize_combined_curves

app = FastAPI(title="Peak10 Facility Dashboard API")

@app.get("/")
def root():
    return {
        "ok": True,
        "service": "Peak10 Facility Dashboard API",
        "health": "/health",
        "docs": "/docs",
    }

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://peak10-warehouse-facility-gpt.netlify.app",
        "http://localhost:3000",
        "http://localhost:5173",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/health")
def health():
    return {"ok": True}

@app.post("/api/upload-model", response_model=ParsedWorkbook)
async def upload_model(file: UploadFile = File(...)):
    if not file.filename:
        raise HTTPException(status_code=400, detail="Missing filename")
    content = await file.read()
    parsed = parse_workbook(content, file.filename)
    MODEL_STORE[parsed.model_id] = parsed
    return parsed

@app.post("/api/run-model", response_model=ModelResponse)
def run_model_endpoint(request: RunModelRequest):
    parsed = MODEL_STORE.get(request.model_id)
    if parsed is None:
        raise HTTPException(status_code=404, detail="Unknown model_id. Upload the workbook again.")
    return run_model(parsed, request.inputs)


@app.get("/api/aegis/ping")
async def aegis_ping_endpoint():
    return await aegis_ping()

@app.get("/api/aegis/entities")
async def aegis_entities_endpoint():
    return await aegis_entities()

@app.get("/api/aegis/combined-curves")
async def aegis_combined_curves_endpoint(as_of_date: str, product_codes: str, start_date: str, end_date: str):
    raw = await aegis_combined_curves(as_of_date=as_of_date, product_codes=product_codes, start_date=start_date, end_date=end_date)
    return {
        "as_of_date": as_of_date,
        "product_codes": product_codes,
        "rows": normalize_combined_curves(raw),
    }
