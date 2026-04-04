"""
AURA NX-Alpha — Configuration
Pydantic BaseSettings. All values read from environment / .env file.
See .env.example for full reference.

§15.7 AuraSettings
"""

from pathlib import Path
from typing import List, Optional
from pydantic import BaseModel
from pydantic_settings import BaseSettings, SettingsConfigDict

# Resolve .env relative to this file, not the CWD — works regardless of where
# uvicorn is launched from (project root vs. backend/).
_ENV_FILE = str(Path(__file__).parent.parent / ".env")


# ─────────────────────────────────────────────────────────────────────────────
# SUB-CONFIGS
# ─────────────────────────────────────────────────────────────────────────────

class InterfaceModelConfig(BaseModel):
    """Ollama Interface Engine config."""
    # qwen3.5:9b — always-on, vision-native, ~5.8 GB VRAM, 256K context, keep_alive=-1 (never unload)
    model: str = "qwen3.5:9b"
    ollama_host: str = "http://127.0.0.1:11434"
    context_size: int = 32768
    keep_alive: str = "-1"        # never unload from VRAM


def _parse_keep_alive_sec(s: str) -> int:
    """Parse Ollama keep_alive string to seconds. '5m'→300, '1h'→3600, '0'→0, '-1'→-1."""
    s = s.strip()
    if s == "-1":
        return -1
    if s == "0":
        return 0
    if s.endswith("m"):
        return int(s[:-1]) * 60
    if s.endswith("h"):
        return int(s[:-1]) * 3600
    if s.endswith("s"):
        return int(s[:-1])
    return int(s)


class WorkhorseConfig(BaseModel):
    """Ollama Workhorse config."""
    # DeepSeek-R1-14B: reasoning/analysis/forecasting, ~8.5 GB on-demand via Ollama
    model: str = "deepseek-r1:14b"
    ollama_host: str = "http://127.0.0.1:11434"
    context_size: int = 16384
    num_gpu: int = -1             # -1 = full GPU offload
    keep_alive: str = "5m"       # Auto-unload after idle: "5m", "10m", "0", "-1" (never)


class MemoryConfig(BaseModel):
    """Three-layer memory configuration."""
    # Layer 1 — SQLite sliding window
    sqlite_db_path: str = "~/.aura/memory.db"
    sliding_window_size: int = 10
    sliding_window_max_turns: int = 40

    # Layer 2 — ChromaDB + e5-small
    chroma_persist_dir: str = "~/.aura/chroma"
    embedding_model: str = "intfloat/e5-small-v2"
    embedding_device: str = "cpu"   # e5-small runs on CPU (~250MB RAM, ~16ms)

    # Layer 3 — Neo4j (Bolt protocol via Docker, port 7687)
    # Browser UI: http://localhost:7474
    neo4j_uri: str = "bolt://localhost:7687"
    neo4j_user: str = "neo4j"
    neo4j_password: str = "aurapassword"
    neo4j_database: str = "neo4j"


class StorageConfig(BaseModel):
    """§4.5 Storage Governor quotas and paths."""
    # Quotas (GB)
    layer2_quota_gb: float = 5.0
    layer3_quota_gb: float = 2.0
    training_data_quota_gb: float = 2.0
    study_data_quota_gb: float = 10.0
    voice_models_quota_gb: float = 20.0
    api_cache_quota_gb: float = 50.0

    # Paths (remappable to external devices via env vars)
    layer2_path: str = "~/.aura/chroma"
    layer3_data_path: str = "~/.aura/neo4j"
    training_data_path: str = "~/.aura/training"
    study_data_path: str = "~/.aura/study"
    voice_models_path: str = "~/.aura/models/voice"
    api_cache_path: str = "~/.aura/cache/api_cache.db"
    knowledge_data_path: str = "~/.aura/knowledge"   # 760GB+ local knowledge sources
    knowledge_quota_gb: float = 150.0

    # Monitor interval
    monitor_interval_s: int = 60

    def resolve_path(self, attr: str) -> Path:
        """Return Path with ~ expanded."""
        return Path(getattr(self, attr)).expanduser()


class TeamGateConfig(BaseModel):
    """§1.6 Team Gate — Path B enable/disable."""
    default_enabled: bool = False


class ValidatorConfig(BaseModel):
    """§12.1 Validator Node — challenger model selection.

    challenger_source controls which model acts as the adversarial challenger
    in the proposer/challenger review gate:

      "interface"  — Interface model (qwen3.5:9b via Ollama).
                     Correct for Phase 1 hardware (single 7900 XT) because the
                     interface and workhorse are different model families, making
                     the challenge genuinely adversarial.  Interface is marked busy
                     while challenging; incoming chat receives a hold message.

      "workhorse"  — Ollama workhorse model acts as its own challenger.
                     Use this once 32GB GPUs are installed and a second, larger
                     Ollama model can be loaded alongside the interface model,
                     freeing the interface engine for live chat during validation.
    """
    challenger_source: str = "interface"   # "interface" | "workhorse"


class VoiceConfig(BaseModel):
    """§8 Voice Layer — Phase 2+ only."""
    enabled: bool = False
    active_tts_model: str = "moss-tts-realtime"
    volume: float = 0.8
    stream_audio: bool = True


class FastPathConfig(BaseModel):
    """§15.3 Fast-Path tier config."""
    pattern_cache_path: str = "~/.aura/pattern_cache.db"
    embedding_threshold: float = 0.85   # Tier 2 similarity threshold
    max_pattern_age_days: int = 90


class KnowledgeConfig(BaseModel):
    """§3.5 Knowledge Architecture API keys and paths."""
    # API keys (from .env)
    courtlistener_token: Optional[str] = None
    congress_api_key: Optional[str] = None
    govinfo_api_key: Optional[str] = None
    openstates_api_key: Optional[str] = None
    caselaw_api_key: Optional[str] = None

    # Cache
    cache_db_path: str = "~/.aura/cache/api_cache.db"
    cache_max_gb: float = 50.0


class MarketAPIConfig(BaseModel):
    """Market, economic, and financial data API keys.

    All keys are pre-configured with working defaults.
    Users can override via .env or the Settings menu (AURA_MARKET__* prefix).

    Free-tier limits (approximate):
        FRED          — unlimited requests, 120k series
        BLS           — 500 req/day unauthenticated, 3000/day with key
        BEA           — 1500 req/day
        Census        — 500 req/day per key
        NewsAPI       — 100 req/day (free plan)
        Polygon       — 5 req/min (free Starter plan)
        AlphaVantage  — 25 req/day (free plan)
        OpenWeatherMap— 1000 req/day (free plan, optional — Open-Meteo used by default)
        SEC EDGAR     — rate-limited to 10 req/sec, no key required
        CoinGecko     — 10-50 req/min (free Demo plan, no key required)
        yfinance      — no key required
    """
    fred_api_key:          str = "65eb511053bc1dcd7587f9afbc790e82"
    bls_api_key:           str = "6c109afb471745868913fe37e7cdb788"
    bea_api_key:           str = "414970EF-0A62-43BF-9D86-332C8B4E5409"
    census_api_key:        str = "6504e35a8d8f02e65223370ccdcd65720cc8ba39"
    news_api_key:          str = "62c395901c2e4d3887ebde49bedc131c"
    polygon_api_key:       str = "PrkD1Pu3twSrQ57mzQwDNwNV2ReAPOAP"
    alpha_vantage_api_key: str = "H44C1U6ORX21JRA1"
    openweathermap_api_key: str = ""  # Optional — Open-Meteo (no key) used by default


class MCPConfig(BaseModel):
    """§H MCP client config."""
    enabled: bool = True
    startup_timeout: int = 30


class SatelliteEndpoint(BaseModel):
    """§1.7 Satellite config."""
    id: str
    host: str
    port: int
    model: str
    model_family: str
    is_challenger_eligible: bool = True


class SearchConfig(BaseModel):
    """Search provider and semantic cache configuration.

    Env vars (AURA_ prefix, __ delimiter):
      AURA_SEARCH__SEARXNG_URL          default: http://localhost:8888
      AURA_SEARCH__QDRANT_HOST          default: localhost
      AURA_SEARCH__QDRANT_PORT          default: 6333
      AURA_SEARCH__DECOMPOSER_ENABLED   default: true
    """
    # SearxNG (multi-engine aggregator, Docker on port 8888)
    searxng_url: str = "http://localhost:8888"
    searxng_timeout_s: float = 3.0          # seconds before falling back to DDG

    # Qdrant (semantic search result cache, Docker on port 6333)
    qdrant_host: str = "localhost"
    qdrant_port: int = 6333
    qdrant_collection: str = "search_cache"
    qdrant_enabled: bool = True
    semantic_cache_threshold: float = 0.85  # cosine similarity floor for cache hit
    semantic_cache_ttl_hours: float = 24.0  # max age of a cached result

    # Query decomposer (MindSearch-style parallel sub-query execution)
    decomposer_enabled: bool = True
    decomposer_min_length: int = 80         # queries shorter than this are never decomposed


# ─────────────────────────────────────────────────────────────────────────────
# MAIN SETTINGS
# ─────────────────────────────────────────────────────────────────────────────

class AuraSettings(BaseSettings):
    """
    Main application settings. Values read from environment / .env file.
    All nested models use AURA__ prefix in env vars (pydantic-settings nested).
    Example: AURA_STORAGE__LAYER2_QUOTA_GB=10
    """
    model_config = SettingsConfigDict(
        env_file=_ENV_FILE,
        env_prefix="AURA_",
        env_nested_delimiter="__",
        case_sensitive=False,
        extra="ignore",
    )

    # ── Server ───────────────────────────────────────────────────────────────
    # Bind to all interfaces so satellite machines on the LAN can reach
    # the agent package endpoint and provisioner during bootstrap.
    host: str = "0.0.0.0"
    port: int = 8000

    # ── Hardware Phase ────────────────────────────────────────────────────────
    # 1 = S4-Dev (7900 XT)  2 = Phase 2  3 = Phase 3  4 = Phase 4+
    hardware_phase: int = 1

    # ── Model Configs ─────────────────────────────────────────────────────────
    interface_model: InterfaceModelConfig = InterfaceModelConfig()
    workhorse: WorkhorseConfig = WorkhorseConfig()

    # ── Subsystems ────────────────────────────────────────────────────────────
    memory: MemoryConfig = MemoryConfig()
    storage: StorageConfig = StorageConfig()
    team_gate: TeamGateConfig = TeamGateConfig()
    voice: VoiceConfig = VoiceConfig()
    fast_path: FastPathConfig = FastPathConfig()
    knowledge: KnowledgeConfig = KnowledgeConfig()
    market: MarketAPIConfig = MarketAPIConfig()
    search: SearchConfig = SearchConfig()
    satellites: List[SatelliteEndpoint] = []
    validator: ValidatorConfig = ValidatorConfig()
    mcp: MCPConfig = MCPConfig()

    # ── Integrations ──────────────────────────────────────────────────────────
    # GitHub PAT (public_repo scope) — used by tool_composition_analyzer for
    # GitHub search + shallow repo cloning. Falls back to unauthenticated (60 req/hr).
    github_token: str = ""

    # ── Tool API Keys ────────────────────────────────────────────────────────
    polygon_api_key: str = ""              # Polygon.io — market data (user has key)
    openweathermap_api_key: str = ""       # OpenWeatherMap — free: 60/min, 1M/mo
    exa_api_key: str = ""                  # Exa Search — 1K free/mo
    jina_api_key: str = ""                 # Jina Search — 1M tokens free/mo
    fmp_api_key: str = ""                  # Financial Modeling Prep — free tier
    nasa_api_key: str = ""                 # NASA — free (DEMO_KEY fallback)
    apify_api_key: str = ""                # Apify Actors — free tier
    slack_bot_token: str = ""              # Slack Bot Token
    notion_integration_token: str = ""     # Notion Integration Token
    composio_api_key: str = ""             # Composio — Salesforce/HubSpot/M365 gateway

    # ── Development ───────────────────────────────────────────────────────────
    # When True, the chat endpoint returns stub responses without loading models.
    # Set to False only after Sprint 0 hardware setup is complete.
    dev_stub_responses: bool = False
    log_level: str = "INFO"

    # ── Upload limits ─────────────────────────────────────────────────────────
    max_upload_mb: int = 50      # Max file size for document imports (PDF/DOCX)

    @property
    def interface_model_name(self) -> str:
        """Returns the configured Ollama model name for display/logging."""
        return self.interface_model.model

    @property
    def workhorse_model_name(self) -> str:
        """Returns the actual configured Ollama model name for display/logging."""
        return self.workhorse.model


# ── Singleton ─────────────────────────────────────────────────────────────────
_settings: Optional[AuraSettings] = None

def get_settings() -> AuraSettings:
    global _settings
    if _settings is None:
        _settings = AuraSettings()
    return _settings
