import {
  CognitoIdentityProviderClient,
  ListUsersCommand,
  AdminCreateUserCommand,
  AdminUpdateUserAttributesCommand,
  AdminDeleteUserCommand,
  AdminAddUserToGroupCommand,
  AdminRemoveUserFromGroupCommand,
  AdminListGroupsForUserCommand,
} from '@aws-sdk/client-cognito-identity-provider';

const cognito = new CognitoIdentityProviderClient();
const USER_POOL_ID = process.env.USER_POOL_ID;

const MANAGED_GROUPS = ['members', 'editors', 'admins'];

const CORS = {
  'Access-Control-Allow-Origin': 'https://oldforest.net',
  'Content-Type': 'application/json',
};

function requireAdmin(event) {
  const claims = event.requestContext?.authorizer?.jwt?.claims ?? {};
  const raw    = claims['cognito:groups'] ?? '';
  const groups = Array.isArray(raw)
    ? raw
    : raw.split(',').map(g => g.trim()).filter(Boolean);
  if (!groups.includes('admins')) {
    const e = new Error('Admin access required');
    e.statusCode = 403;
    throw e;
  }
}

function ok(body, status = 200) {
  return { statusCode: status, headers: CORS, body: JSON.stringify(body) };
}
function errRes(status, message) {
  return { statusCode: status, headers: CORS, body: JSON.stringify({ message }) };
}

async function getUserGroups(username) {
  const res = await cognito.send(new AdminListGroupsForUserCommand({
    UserPoolId: USER_POOL_ID,
    Username: username,
  }));
  return (res.Groups || []).map(g => g.GroupName);
}

export const handler = async (event) => {
  try { requireAdmin(event); }
  catch (e) { return errRes(e.statusCode || 403, e.message); }

  const method   = event.requestContext?.http?.method;
  const username = event.pathParameters?.username
    ? decodeURIComponent(event.pathParameters.username)
    : null;

  try {
    // ── GET /v1/admin/users ────────────────────
    if (method === 'GET' && !username) {
      const result = await cognito.send(new ListUsersCommand({
        UserPoolId: USER_POOL_ID,
        Limit: 60,
      }));

      const users = await Promise.all((result.Users || []).map(async (u) => {
        const attrs = Object.fromEntries(
          (u.Attributes || []).map(a => [a.Name, a.Value])
        );
        const groups = await getUserGroups(u.Username);
        return {
          username: u.Username,
          email: attrs.email || '',
          name: attrs.name || '',
          status: u.UserStatus,
          enabled: u.Enabled,
          created: u.UserCreateDate,
          groups,
        };
      }));

      return ok({ users });
    }

    // ── POST /v1/admin/users ───────────────────
    if (method === 'POST' && !username) {
      const body = JSON.parse(event.body ?? '{}');
      const { email, name, role } = body;

      if (!email) return errRes(400, 'email is required');

      const result = await cognito.send(new AdminCreateUserCommand({
        UserPoolId: USER_POOL_ID,
        Username: email,
        UserAttributes: [
          { Name: 'email', Value: email },
          { Name: 'email_verified', Value: 'true' },
          ...(name ? [{ Name: 'name', Value: name }] : []),
        ],
        DesiredDeliveryMediums: ['EMAIL'],
      }));

      // Assign role group if specified
      if (role && MANAGED_GROUPS.includes(role)) {
        await cognito.send(new AdminAddUserToGroupCommand({
          UserPoolId: USER_POOL_ID,
          Username: result.User.Username,
          GroupName: role,
        }));
      }

      return ok({ username: result.User.Username }, 201);
    }

    // ── PUT /v1/admin/users/{username} ─────────
    if (method === 'PUT' && username) {
      const body = JSON.parse(event.body ?? '{}');

      // Update display name if provided
      if (body.name !== undefined) {
        await cognito.send(new AdminUpdateUserAttributesCommand({
          UserPoolId: USER_POOL_ID,
          Username: username,
          UserAttributes: [{ Name: 'name', Value: body.name }],
        }));
      }

      // Update role/group if provided
      if (body.role !== undefined) {
        const currentGroups = await getUserGroups(username);
        // Remove from all managed groups
        for (const g of currentGroups) {
          if (MANAGED_GROUPS.includes(g)) {
            await cognito.send(new AdminRemoveUserFromGroupCommand({
              UserPoolId: USER_POOL_ID,
              Username: username,
              GroupName: g,
            }));
          }
        }
        // Add to new group if role is set
        if (body.role && MANAGED_GROUPS.includes(body.role)) {
          await cognito.send(new AdminAddUserToGroupCommand({
            UserPoolId: USER_POOL_ID,
            Username: username,
            GroupName: body.role,
          }));
        }
      }

      return ok({ message: 'Updated' });
    }

    // ── DELETE /v1/admin/users/{username} ──────
    if (method === 'DELETE' && username) {
      await cognito.send(new AdminDeleteUserCommand({
        UserPoolId: USER_POOL_ID,
        Username: username,
      }));
      return { statusCode: 204, headers: CORS, body: '' };
    }

    return errRes(405, 'Method not allowed');
  } catch (e) {
    console.error('admin-users error:', e);
    if (e.name === 'UserNotFoundException')     return errRes(404, 'User not found');
    if (e.name === 'UsernameExistsException')   return errRes(409, 'User already exists');
    if (e.name === 'InvalidParameterException') return errRes(400, 'Invalid parameter');
    return errRes(500, 'Internal server error');
  }
};
