import pytest
from pydantic import ValidationError

from backend.api.models import LoginRequest, RegisterRequest


def test_login_request_allows_single_character_username():
    payload = LoginRequest(username="Q", password="heiheihei666")

    assert payload.username == "Q"


def test_register_request_strips_username_whitespace():
    payload = RegisterRequest(username="  Q  ", password="heiheihei666")

    assert payload.username == "Q"


def test_login_request_rejects_blank_username():
    with pytest.raises(ValidationError) as error:
        LoginRequest(username="   ", password="heiheihei666")

    assert "用户名不能为空" in str(error.value)
