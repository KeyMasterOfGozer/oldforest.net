import {
  CognitoIdentityProviderClient,
  GetUserCommand,
  UpdateUserAttributesCommand,
  ChangePasswordCommand,
} from '@aws-sdk/client-cognito-identity-provider';

const cognito = new CognitoIdentityProviderClient();

function rawToken(event) {
  return (event.headers?.authorization || '').replace(/^Bearer\s+/i, '');
}

export const handler = async (event) => {
  const token = rawToken(event);
  if (!token) return { statusCode: 401, body: JSON.stringify({ message: 'Unauthorized' }) };

  const method = event.requestMethod || event.httpMethod || event.requestContext?.http?.method;

  try {
    // GET /v1/profile — return current user attributes
    if (method === 'GET') {
      const result = await cognito.send(new GetUserCommand({ AccessToken: token }));
      const attrs = Object.fromEntries(result.UserAttributes.map(a => [a.Name, a.Value]));
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: attrs.email, name: attrs.name || '' }),
      };
    }

    // PUT /v1/profile — update display name
    if (method === 'PUT') {
      const body = JSON.parse(event.body ?? '{}');
      await cognito.send(new UpdateUserAttributesCommand({
        AccessToken: token,
        UserAttributes: [{ Name: 'name', Value: body.name ?? '' }],
      }));
      return { statusCode: 200, body: JSON.stringify({ message: 'Updated' }) };
    }

    // POST /v1/profile/password — change password
    if (method === 'POST') {
      const body = JSON.parse(event.body ?? '{}');
      if (!body.oldPassword || !body.newPassword) {
        return { statusCode: 400, body: JSON.stringify({ message: 'oldPassword and newPassword required' }) };
      }
      await cognito.send(new ChangePasswordCommand({
        AccessToken: token,
        PreviousPassword: body.oldPassword,
        ProposedPassword: body.newPassword,
      }));
      return { statusCode: 200, body: JSON.stringify({ message: 'Password changed' }) };
    }

    return { statusCode: 405, body: JSON.stringify({ message: 'Method not allowed' }) };

  } catch (e) {
    const status = e.name === 'NotAuthorizedException' ? 401
                 : e.name === 'InvalidPasswordException' ? 400
                 : 500;
    return { statusCode: status, body: JSON.stringify({ message: e.message }) };
  }
};
