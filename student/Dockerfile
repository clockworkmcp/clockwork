FROM python:3.12-slim
WORKDIR /app
COPY requirements.lock ./
# CPU-only torch keeps the image small; the student never needs a GPU.
RUN pip install --no-cache-dir -r requirements.lock --index-url https://pypi.org/simple --extra-index-url https://download.pytorch.org/whl/cpu
COPY *.py retrain-loop.sh ./
ENV CLOCKWORK_DATA=/data CLOCKWORK_STUDENT_HOST=0.0.0.0 HF_HOME=/data/student/hf
EXPOSE 4601
CMD ["python", "serve.py"]
