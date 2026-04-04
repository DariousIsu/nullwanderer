"""
AURA NX-Alpha — Agent Library
Pre-built agent templates for the Planner to assign to tasks.

Structure:
    agents/
        base.py              ← BaseAgent (all templates inherit this)
        planner.py           ← PlannerAgent (reads registry, assigns work)
        registry.json        ← Machine-readable template catalog
        tools/
            free_sources.py  ← All API integrations (FRED, BLS, Polygon, etc.)
            streaming.py     ← Real-time data stream loops
            technical_analysis.py ← TA indicator computations
        templates/
            data/            ← Data acquisition agents
            analysis/        ← Intelligence/analysis agents
            forecasting/     ← Prediction & ML agents
            trading/         ← Trading strategy agents
            utility/         ← Weather impact, news routing, etc.
"""
