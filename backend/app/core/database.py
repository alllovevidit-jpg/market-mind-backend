import os
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

# Fetch from environment, fallback to the docker-compose defaults
DATABASE_URL = os.getenv(
    "DATABASE_URL", 
    "postgresql://marketmind_user:marketmind_password@localhost:5432/marketmind_db"
)

# Create the engine. echo=False in production to avoid logging every query
engine = create_engine(DATABASE_URL, echo=False)

# Create a configured "Session" class
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

# Dependency to inject DB sessions into FastAPI routes
def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()