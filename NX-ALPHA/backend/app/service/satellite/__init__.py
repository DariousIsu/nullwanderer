"""
AURA NX-Alpha — Satellite Infrastructure
Distributed inference management: discovery, registry, governor, health polling, provisioning.

Structure:
    satellite/
        discovery.py      — LAN network scanning for bootstrap/agent ports
        registry.py       — SQLite satellite registry (CRUD + persistence)
        governor.py       — Hardware governor (thermal/VRAM/RAM thresholds + circuit breaker)
        health_poller.py  — Background health polling loop
        provisioner.py    — Remote provisioning orchestrator
"""
