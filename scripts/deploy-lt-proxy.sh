#!/usr/bin/env bash
# Deploy (create or update) the oldforest-lt-proxy Lambda.
# Usage: AWS_PROFILE=oldforest bash scripts/deploy-lt-proxy.sh
set -euo pipefail

FUNCTION_NAME="oldforest-lt-proxy"
REGION="us-east-1"
ROLE_NAME="oldforest-lt-proxy"
RUNTIME="nodejs20.x"
HANDLER="index.handler"
TIMEOUT=30
MEMORY=256
LT_API_KEY="2025452350"
LT_USER_ID="KeyMasterOfGozer"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC_DIR="$REPO_ROOT/src/functions/lt-proxy"
ZIP_FILE="/tmp/lt-proxy-deploy.zip"

echo "==> Packaging $SRC_DIR → $ZIP_FILE"
(cd "$SRC_DIR" && zip -qr "$ZIP_FILE" .)

# Does the function already exist?
if aws lambda get-function --function-name "$FUNCTION_NAME" --region "$REGION" \
      --query 'Configuration.FunctionArn' --output text 2>/dev/null | grep -q arn; then
  echo "==> Updating existing Lambda: $FUNCTION_NAME"
  aws lambda update-function-code \
    --function-name "$FUNCTION_NAME" \
    --zip-file "fileb://$ZIP_FILE" \
    --region "$REGION" \
    --query 'FunctionArn' --output text

  # Wait for code update to finish before updating config
  aws lambda wait function-updated --function-name "$FUNCTION_NAME" --region "$REGION"

  aws lambda update-function-configuration \
    --function-name "$FUNCTION_NAME" \
    --timeout "$TIMEOUT" \
    --memory-size "$MEMORY" \
    --environment "Variables={LT_API_KEY=$LT_API_KEY,LT_USER_ID=$LT_USER_ID}" \
    --region "$REGION" \
    --query 'FunctionArn' --output text
  echo "==> Updated."
else
  # Need the IAM role ARN to create the function
  echo "==> Lambda not found — creating it."
  ROLE_ARN=$(aws iam get-role --role-name "$ROLE_NAME" \
    --query 'Role.Arn' --output text 2>/dev/null || echo "")

  if [ -z "$ROLE_ARN" ]; then
    echo ""
    echo "ERROR: IAM role '$ROLE_NAME' not found either."
    echo "Run 'terraform apply' first to create the role, then re-run this script."
    exit 1
  fi

  echo "==> Using role: $ROLE_ARN"
  aws lambda create-function \
    --function-name "$FUNCTION_NAME" \
    --runtime "$RUNTIME" \
    --handler "$HANDLER" \
    --role "$ROLE_ARN" \
    --zip-file "fileb://$ZIP_FILE" \
    --timeout "$TIMEOUT" \
    --memory-size "$MEMORY" \
    --environment "Variables={LT_API_KEY=$LT_API_KEY,LT_USER_ID=$LT_USER_ID}" \
    --region "$REGION" \
    --query 'FunctionArn' --output text
  echo "==> Created."

  # -----------------------------------------------------------------------
  # If the API Gateway route also needs a Lambda permission, add it here.
  # Get the API ID first:
  API_ID=$(aws apigatewayv2 get-apis --region "$REGION" \
    --query "Items[?Name=='oldforest-api'].ApiId | [0]" --output text 2>/dev/null || echo "")

  if [ -n "$API_ID" ] && [ "$API_ID" != "None" ]; then
    echo "==> Adding Lambda invoke permission for API Gateway (API: $API_ID)"
    aws lambda add-permission \
      --function-name "$FUNCTION_NAME" \
      --statement-id "apigw-lt-proxy" \
      --action lambda:InvokeFunction \
      --principal apigateway.amazonaws.com \
      --source-arn "arn:aws:execute-api:$REGION:$(aws sts get-caller-identity --query Account --output text):$API_ID/*/*/v1/proxy/librarything" \
      --region "$REGION" 2>/dev/null || echo "  (permission may already exist, continuing)"
  else
    echo "  (could not find API ID to add invoke permission — run terraform apply to wire up the route)"
  fi
fi

echo ""
echo "==> Testing Lambda directly (invoke):"
aws lambda invoke \
  --function-name "$FUNCTION_NAME" \
  --region "$REGION" \
  --cli-binary-format raw-in-base64-out \
  --payload '{}' \
  /tmp/lt-proxy-response.json \
  --query 'StatusCode' --output text
echo "Lambda returned status code above."
echo ""
echo "Response preview (first 300 chars):"
cat /tmp/lt-proxy-response.json | head -c 300
echo ""
