from pydantic import BaseModel
from typing import Optional

class MessageCreate(BaseModel):
    channel: str
    category: str
    to: str
    subject: Optional[str] = None
    body: str
    idempotency_key: Optional[str] = None