import unittest
from unittest.mock import AsyncMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.api.routes import interview
from backend.database.models import InterviewSession
from backend.services.auth_service import create_access_token
from backend.services.smart_interview_agent import InterviewServiceError


def _build_app() -> FastAPI:
    app = FastAPI()
    app.include_router(interview.router)
    return app


class InterviewRouteTest(unittest.TestCase):
    def test_interview_start_requires_authorization_header(self):
        client = TestClient(_build_app())

        response = client.post("/api/interview/start", json={})

        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.json()["detail"], "缺少 Authorization 认证信息")

    @patch("backend.api.routes.interview._persist_agent_snapshot")
    @patch("backend.api.routes.interview.SmartInterviewAgent.start", new_callable=AsyncMock)
    def test_interview_start_succeeds_with_valid_token(self, mocked_start, _mocked_persist):
        mocked_start.return_value = {
            "action": "ask",
            "message": {
                "type": "text",
                "content": "先说说你这篇笔记最想解决什么问题？",
            },
        }

        client = TestClient(_build_app())
        token = create_access_token(subject="user-interview-1", username="tester")

        response = client.post(
            "/api/interview/start",
            headers={"Authorization": f"Bearer {token}"},
            json={},
        )

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertTrue(body["session_id"])
        self.assertEqual(body["action"], "ask")
        self.assertEqual(body["message"]["content"], "先说说你这篇笔记最想解决什么问题？")

    @patch("backend.api.routes.interview.SmartInterviewAgent.start", new_callable=AsyncMock)
    def test_interview_start_returns_readable_gateway_error(self, mocked_start):
        mocked_start.side_effect = InterviewServiceError(
            "访谈模型响应超时，请稍后重试。",
            status_code=504,
            kind="timeout",
            raw_error="request timed out",
        )

        client = TestClient(_build_app())
        token = create_access_token(subject="user-interview-2", username="tester")

        response = client.post(
            "/api/interview/start",
            headers={"Authorization": f"Bearer {token}"},
            json={},
        )

        self.assertEqual(response.status_code, 504)
        self.assertEqual(response.json()["detail"], "访谈模型响应超时，请稍后重试。")

    @patch("backend.api.routes.interview._persist_agent_snapshot")
    @patch("backend.api.routes.interview.SmartInterviewAgent.handle_message", new_callable=AsyncMock)
    def test_interview_message_succeeds_with_valid_token(self, mocked_handle_message, _mocked_persist):
        mocked_handle_message.return_value = {
            "action": "ask",
            "message": {
                "type": "text",
                "content": "为什么你现在特别想做这篇内容？",
            },
        }

        client = TestClient(_build_app())
        token = create_access_token(subject="user-interview-3", username="tester")
        mock_agent = AsyncMock()
        mock_agent.handle_message = mocked_handle_message

        with patch("backend.api.routes.interview.sessions", {"session-1": mock_agent}):
            response = client.post(
                "/api/interview/message",
                headers={"Authorization": f"Bearer {token}"},
                json={
                    "session_id": "session-1",
                    "message": "我想做获客",
                },
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["message"]["content"], "为什么你现在特别想做这篇内容？")

    @patch("backend.api.routes.interview.SmartInterviewAgent.handle_message", new_callable=AsyncMock)
    def test_interview_message_returns_readable_gateway_error(self, mocked_handle_message):
        mocked_handle_message.side_effect = InterviewServiceError(
            "模型通道不可用：当前无法连接内网模型网关，请检查 VPN、专线或出口代理。",
            status_code=503,
            kind="network_unreachable",
            raw_error="connection refused",
        )

        client = TestClient(_build_app())
        token = create_access_token(subject="user-interview-4", username="tester")
        mock_agent = AsyncMock()
        mock_agent.handle_message = mocked_handle_message

        with patch("backend.api.routes.interview.sessions", {"session-2": mock_agent}):
            response = client.post(
                "/api/interview/message",
                headers={"Authorization": f"Bearer {token}"},
                json={
                    "session_id": "session-2",
                    "message": "最近线索掉了很多",
                },
            )

        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()["detail"], "模型通道不可用：当前无法连接内网模型网关，请检查 VPN、专线或出口代理。")

    @patch("backend.api.routes.interview._persist_agent_snapshot")
    @patch("backend.api.routes.interview._restore_agent_from_db")
    def test_interview_message_restores_missing_memory_session(self, mocked_restore, _mocked_persist):
        restored_agent = AsyncMock()
        restored_agent.handle_message = AsyncMock(return_value={
            "action": "ask",
            "message": {"type": "text", "content": "恢复后继续问一句"},
        })
        mocked_restore.return_value = restored_agent

        client = TestClient(_build_app())
        token = create_access_token(subject="user-interview-5", username="tester")

        with patch("backend.api.routes.interview.sessions", {}):
            response = client.post(
                "/api/interview/message",
                headers={"Authorization": f"Bearer {token}"},
                json={
                    "session_id": "session-restored",
                    "message": "继续",
                },
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["message"]["content"], "恢复后继续问一句")
        mocked_restore.assert_called_once()

    @patch("backend.api.routes.interview.get_latest_interview_session")
    def test_get_current_interview_session_returns_ui_snapshot(self, mocked_latest):
        row = InterviewSession(
            session_id="session-1",
            user_id="user-interview-6",
            status="asking",
            agent_snapshot="{}",
            ui_snapshot='{"messages":[{"role":"assistant","content":"hi"}]}',
        )
        mocked_latest.return_value = row

        client = TestClient(_build_app())
        token = create_access_token(subject="user-interview-6", username="tester")

        response = client.get(
            "/api/interview/session/current",
            headers={"Authorization": f"Bearer {token}"},
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["data"]["ui_snapshot"]["messages"][0]["content"], "hi")


if __name__ == "__main__":
    unittest.main()
