import uvicorn
from geotagger.config import HOST, PORT


def main():
    uvicorn.run(
        "geotagger.main:app",
        host=HOST,
        port=PORT,
        reload=False,
    )


if __name__ == "__main__":
    main()
