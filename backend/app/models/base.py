from sqlalchemy.orm import DeclarativeBase
from datetime import datetime
from sqlalchemy import DateTime
from sqlalchemy.orm import Mapped, mapped_column

class Base(DeclarativeBase):
    pass

class TimestampMixin:
    """Mixin to automatically track row creation and updates."""
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=datetime.utcnow, onupdate=datetime.utcnow
    )