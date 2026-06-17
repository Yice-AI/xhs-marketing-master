import asyncio
import uuid
from typing import Dict, Any, Optional, Callable
from datetime import datetime
from enum import Enum
import threading


class TaskStatus(str, Enum):
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


class Task:
    def __init__(self, task_id: str, name: str, metadata: Optional[Dict[str, Any]] = None):
        self.task_id = task_id
        self.name = name
        self.status = TaskStatus.PENDING
        self.progress = 0
        self.message = ""
        self.result = None
        self.error = None
        self.metadata: Dict[str, Any] = metadata.copy() if metadata else {}
        self.created_at = datetime.now()
        self.started_at: Optional[datetime] = None
        self.completed_at: Optional[datetime] = None
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            "task_id": self.task_id,
            "name": self.name,
            "status": self.status.value,
            "progress": self.progress,
            "message": self.message,
            "result": self.result,
            "error": self.error,
            "metadata": self.metadata,
            "created_at": self.created_at.isoformat(),
            "started_at": self.started_at.isoformat() if self.started_at else None,
            "completed_at": self.completed_at.isoformat() if self.completed_at else None,
        }


class TaskManager:
    _instance = None
    
    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            cls._instance._initialized = False
        return cls._instance
    
    def __init__(self):
        if self._initialized:
            return
        self._initialized = True
        self.tasks: Dict[str, Task] = {}
        self._lock = asyncio.Lock()
        self._sync_lock = threading.RLock()
    
    def create_task(self, name: str, metadata: Optional[Dict[str, Any]] = None) -> str:
        task_id = str(uuid.uuid4())
        task = Task(task_id, name, metadata=metadata)
        with self._sync_lock:
            self.tasks[task_id] = task
        return task_id

    def _apply_update(
        self,
        task: Task,
        *,
        status: Optional[TaskStatus] = None,
        progress: Optional[int] = None,
        message: Optional[str] = None,
        result: Optional[Any] = None,
        error: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None
    ) -> None:
        if task.status == TaskStatus.CANCELLED and status != TaskStatus.CANCELLED:
            return

        if status:
            task.status = status
            if status == TaskStatus.RUNNING and not task.started_at:
                task.started_at = datetime.now()
            elif status in [TaskStatus.COMPLETED, TaskStatus.FAILED, TaskStatus.CANCELLED]:
                task.completed_at = datetime.now()
        
        if progress is not None:
            task.progress = progress
        
        if message is not None:
            task.message = message
        
        if result is not None:
            task.result = result
        
        if error is not None:
            task.error = error

        if metadata:
            task.metadata.update(metadata)
    
    async def update_task(
        self,
        task_id: str,
        status: Optional[TaskStatus] = None,
        progress: Optional[int] = None,
        message: Optional[str] = None,
        result: Optional[Any] = None,
        error: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None
    ):
        async with self._lock:
            if task_id not in self.tasks:
                raise ValueError(f"Task {task_id} not found")
            
            task = self.tasks[task_id]
            self._apply_update(
                task,
                status=status,
                progress=progress,
                message=message,
                result=result,
                error=error,
                metadata=metadata,
            )

    def update_task_sync(
        self,
        task_id: str,
        status: Optional[TaskStatus] = None,
        progress: Optional[int] = None,
        message: Optional[str] = None,
        result: Optional[Any] = None,
        error: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None
    ) -> None:
        with self._sync_lock:
            if task_id not in self.tasks:
                raise ValueError(f"Task {task_id} not found")

            task = self.tasks[task_id]
            self._apply_update(
                task,
                status=status,
                progress=progress,
                message=message,
                result=result,
                error=error,
                metadata=metadata,
            )

    def set_task_snapshot(self, snapshot: Dict[str, Any]) -> None:
        task_id = snapshot["task_id"]
        metadata = snapshot.get("metadata") or {}
        task = Task(task_id, snapshot.get("name", "任务"), metadata=metadata)
        task.status = TaskStatus(snapshot.get("status", TaskStatus.PENDING.value))
        task.progress = snapshot.get("progress", 0)
        task.message = snapshot.get("message") or ""
        task.result = snapshot.get("result")
        task.error = snapshot.get("error")
        created_at = snapshot.get("created_at")
        started_at = snapshot.get("started_at")
        completed_at = snapshot.get("completed_at")
        if created_at:
            task.created_at = datetime.fromisoformat(created_at)
        if started_at:
            task.started_at = datetime.fromisoformat(started_at)
        if completed_at:
            task.completed_at = datetime.fromisoformat(completed_at)
        with self._sync_lock:
            self.tasks[task_id] = task
    
    def get_task(self, task_id: str) -> Optional[Dict[str, Any]]:
        task = self.tasks.get(task_id)
        return task.to_dict() if task else None
    
    def get_all_tasks(self) -> Dict[str, Dict[str, Any]]:
        return {task_id: task.to_dict() for task_id, task in self.tasks.items()}
    
    async def run_task(
        self,
        task_id: str,
        func: Callable,
        *args,
        **kwargs
    ):
        try:
            await self.update_task(
                task_id,
                status=TaskStatus.RUNNING,
                message="任务开始执行"
            )
            
            result = await func(*args, **kwargs)
            
            await self.update_task(
                task_id,
                status=TaskStatus.COMPLETED,
                progress=100,
                message="任务完成",
                result=result
            )
            
        except Exception as e:
            await self.update_task(
                task_id,
                status=TaskStatus.FAILED,
                message="任务失败",
                error=str(e)
            )
            raise
    
    def cleanup_old_tasks(self, max_age_hours: int = 24):
        now = datetime.now()
        to_remove = []
        
        for task_id, task in self.tasks.items():
            if task.completed_at:
                age = (now - task.completed_at).total_seconds() / 3600
                if age > max_age_hours:
                    to_remove.append(task_id)
        
        for task_id in to_remove:
            del self.tasks[task_id]


task_manager = TaskManager()
