import sys
import os
sys.path.insert(0, os.path.abspath(os.path.dirname(__file__)))

from sqlalchemy import create_engine
from backend.database.models import Base
from backend.config.settings import settings

def main():
    engine = create_engine(settings.DATABASE_URL)
    Base.metadata.create_all(engine)
    print("Tables created successfully")

main()
