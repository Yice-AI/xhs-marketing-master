import asyncio
from backend.services.smart_interview_agent import SmartInterviewAgent
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.dirname(__file__)))

async def test():
    agent = SmartInterviewAgent(user_id="test")
    res = await agent.start()
    print(res)

if __name__ == "__main__":
    from dotenv import load_dotenv
    load_dotenv()
    asyncio.run(test())
