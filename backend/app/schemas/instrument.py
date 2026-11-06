from sqlalchemy import String, Boolean
from sqlalchemy.orm import Mapped, mapped_column
from app.models.base import Base, TimestampMixin

class Instrument(Base, TimestampMixin):
    __tablename__ = "instruments"
    
    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    symbol: Mapped[str] = mapped_column(String, unique=True, index=True)
    company_name: Mapped[str] = mapped_column(String)
    exchange: Mapped[str] = mapped_column(String, default="NSE")
    sector: Mapped[str | None] = mapped_column(String, nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)