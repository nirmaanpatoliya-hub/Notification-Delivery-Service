from pydantic import BaseModel, Field
from typing import Optional

class MessageCreate(BaseModel):
    channel: str
    category: str
    to: str
    subject: Optional[str] = None
    body: str
    idempotency_key: Optional[str] = None

class WorkerUpdate(BaseModel):
    paused: bool

class ProviderUpdate(BaseModel):
    outage: Optional[bool] = None
    fail_rate: Optional[float] = None