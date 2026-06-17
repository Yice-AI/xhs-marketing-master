from datetime import datetime, timedelta
from collections import deque
from typing import Tuple
import json
from pathlib import Path

class PublishRateLimiter:
    def __init__(self):
        self.data_file = Path(__file__).parent.parent / "logs" / "publish_history.json"
        self.data_file.parent.mkdir(parents=True, exist_ok=True)
        self.publish_times = self._load_history()
    
    def _load_history(self) -> deque:
        if self.data_file.exists():
            try:
                with open(self.data_file, 'r') as f:
                    data = json.load(f)
                    times = [datetime.fromisoformat(t) for t in data]
                    return deque(times, maxlen=20)
            except:
                pass
        return deque(maxlen=20)
    
    def _save_history(self):
        with open(self.data_file, 'w') as f:
            times = [t.isoformat() for t in self.publish_times]
            json.dump(times, f)
    
    def can_publish(self) -> Tuple[bool, str]:
        now = datetime.now()
        
        while self.publish_times and now - self.publish_times[0] > timedelta(hours=24):
            self.publish_times.popleft()
        
        # 测试模式：临时提高限额到 100 次/24小时
        if len(self.publish_times) >= 100:
            return False, "今日发布次数已达上限（100次/24小时），请明天再试"
        
        # 测试模式：临时缩短间隔到 10 秒
        if self.publish_times:
            last = self.publish_times[-1]
            elapsed = (now - last).total_seconds()
            if elapsed < 10:
                wait_time = int(10 - elapsed)
                return False, f"发布过于频繁，请等待 {wait_time} 秒后再试"
        
        return True, "可以发布"
    
    def record_publish(self):
        self.publish_times.append(datetime.now())
        self._save_history()
    
    def get_quota_info(self) -> dict:
        now = datetime.now()
        
        while self.publish_times and now - self.publish_times[0] > timedelta(hours=24):
            self.publish_times.popleft()
        
        recent_count = len(self.publish_times)
        
        # 测试模式：显示 100 次限额
        return {
            "total": 100,
            "used": recent_count,
            "remaining": max(0, 100 - recent_count)
        }

_rate_limiter = None

def get_rate_limiter() -> PublishRateLimiter:
    global _rate_limiter
    if _rate_limiter is None:
        _rate_limiter = PublishRateLimiter()
    return _rate_limiter
