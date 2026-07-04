"""Model registry — name → Model class. Adding a model = drop a file in models/ + register it here."""
from models.poll_baseline import PollBaseline
from models.uniform_swing import UniformSwing
from models.fundamentals_stub import FundamentalsStub

REGISTRY = {m.name: m for m in [PollBaseline, UniformSwing, FundamentalsStub]}


def get(name):
    return REGISTRY.get(name)


def names():
    return list(REGISTRY.keys())
