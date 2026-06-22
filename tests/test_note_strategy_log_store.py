import json

from sqlalchemy import create_engine, text

from backend.database import db_session
from backend.database.models import Base
from backend.utils import note_strategy_log_store


def test_save_note_strategy_log_persists_strategy_payload(monkeypatch):
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(bind=engine)
    monkeypatch.setattr(db_session, "engine", engine)
    monkeypatch.setattr(
        type(note_strategy_log_store.settings),
        "allow_runtime_schema_fallback",
        property(lambda self: True),
    )

    log_id = note_strategy_log_store.save_note_strategy_log({
        "user_id": "user-1",
        "product_name": "微伴助手",
        "strategy_mode": "research_first",
        "research_context": {"product_name": "微伴助手", "summary": "SCRM"},
        "benchmark_note": None,
        "real_phrases": ["销售跟进"],
        "strategy_feedback": "多样化一点",
        "response_payload": {
            "selected_strategy_id": "s1",
            "product_usage_mode": "product_main",
            "benchmark_fit": {"fit_level": "research_only"},
            "strategies": [{"id": "s1", "label": "老板决策版"}],
            "fallback_used": False,
        },
        "model_name": "gpt-test",
        "runtime_ms": 123,
    })

    assert log_id
    with engine.begin() as conn:
        row = conn.execute(text("""
            SELECT user_id, product_name, strategy_mode, product_usage_mode,
                   selected_strategy_id, fallback_used, strategies, response_payload
            FROM note_strategy_logs
            WHERE log_id = :log_id
        """), {"log_id": log_id}).mappings().one()

    assert row["user_id"] == "user-1"
    assert row["product_name"] == "微伴助手"
    assert row["strategy_mode"] == "research_first"
    assert row["product_usage_mode"] == "product_main"
    assert row["selected_strategy_id"] == "s1"
    assert row["fallback_used"] in (False, 0)
    assert json.loads(row["strategies"])[0]["label"] == "老板决策版"
    assert json.loads(row["response_payload"])["benchmark_fit"]["fit_level"] == "research_only"


def test_list_recent_note_strategy_signals_returns_compact_direction_text(monkeypatch):
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(bind=engine)
    monkeypatch.setattr(db_session, "engine", engine)
    monkeypatch.setattr(
        type(note_strategy_log_store.settings),
        "allow_runtime_schema_fallback",
        property(lambda self: True),
    )

    note_strategy_log_store.save_note_strategy_log({
        "user_id": "user-1",
        "product_name": "微伴助手",
        "strategy_mode": "research_first",
        "research_context": {"product_name": "微伴助手"},
        "response_payload": {
            "selected_strategy_id": "s1",
            "product_usage_mode": "product_main",
            "strategies": [
                {
                    "id": "s1",
                    "label": "老板经营诊断型",
                    "contentAngle": "经营问题拆解",
                    "summary": "从老板看不到客户资产沉淀切入。",
                },
                {
                    "id": "s2",
                    "label": "合规风控型",
                    "contentAngle": "风险场景拆解",
                    "summary": "围绕会话留痕和敏感词预警展开。",
                },
            ],
            "fallback_used": False,
        },
    })

    signals = note_strategy_log_store.list_recent_note_strategy_signals(
        user_id="user-1",
        product_name="微伴助手",
        strategy_mode="research_first",
    )

    assert signals == [
        "从老板看不到客户资产沉淀切入。",
        "围绕会话留痕和敏感词预警展开。",
    ]
