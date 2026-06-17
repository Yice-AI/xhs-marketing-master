import json
from datetime import datetime
from pathlib import Path
from typing import Optional

class PublishLogger:
    def __init__(self):
        self.log_file = Path(__file__).parent.parent / "logs" / "publish_log.jsonl"
        self.log_file.parent.mkdir(parents=True, exist_ok=True)
    
    def log_publish(self, title: str, status: str, error: Optional[str] = None, images_count: int = 0):
        log_entry = {
            "timestamp": datetime.now().isoformat(),
            "title": title,
            "status": status,
            "images_count": images_count,
            "error": error
        }
        
        with open(self.log_file, 'a', encoding='utf-8') as f:
            f.write(json.dumps(log_entry, ensure_ascii=False) + '\n')

_publish_logger = None

def get_publish_logger() -> PublishLogger:
    global _publish_logger
    if _publish_logger is None:
        _publish_logger = PublishLogger()
    return _publish_logger
