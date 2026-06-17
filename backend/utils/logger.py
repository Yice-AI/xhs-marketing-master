import re
import logging
from pathlib import Path
from datetime import datetime


def sanitize_log(message: str) -> str:
    message = re.sub(r'(api[_-]?key["\s:=]+)[\w-]+', r'\1***', message, flags=re.IGNORECASE)
    message = re.sub(r'(cookie["\s:=]+)[^;]+', r'\1***', message, flags=re.IGNORECASE)
    message = re.sub(r'(token["\s:=]+)[\w.-]+', r'\1***', message, flags=re.IGNORECASE)
    return message


class SanitizingFormatter(logging.Formatter):
    def format(self, record):
        original = super().format(record)
        return sanitize_log(original)


def setup_logger(name: str = "xhs_backend") -> logging.Logger:
    logger = logging.getLogger(name)
    logger.setLevel(logging.INFO)
    
    if logger.handlers:
        return logger
    
    log_dir = Path(__file__).parent.parent / "logs"
    log_dir.mkdir(exist_ok=True)
    
    log_file = log_dir / f"api_{datetime.now().strftime('%Y%m%d')}.log"
    
    file_handler = logging.FileHandler(log_file, encoding='utf-8')
    file_handler.setLevel(logging.INFO)
    
    console_handler = logging.StreamHandler()
    console_handler.setLevel(logging.INFO)
    
    formatter = SanitizingFormatter(
        '%(asctime)s - %(name)s - %(levelname)s - %(message)s',
        datefmt='%Y-%m-%d %H:%M:%S'
    )
    
    file_handler.setFormatter(formatter)
    console_handler.setFormatter(formatter)
    
    logger.addHandler(file_handler)
    logger.addHandler(console_handler)
    
    return logger


logger = setup_logger()
