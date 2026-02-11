// Replace {{variables}} in email templates with actual contact data
export function replaceVariables(
  template: string,
  contact: {
    first_name?: string;
    last_name?: string;
    email?: string;
    company?: string;
    phone?: string;
    [key: string]: any;
  }
): string {
  if (!template) return '';

  let result = template;

  // Standard variables
  const replacements: Record<string, string> = {
    firstName: contact.first_name || '',
    lastName: contact.last_name || '',
    email: contact.email || '',
    company: contact.company || '',
    phone: contact.phone || '',
    fullName: `${contact.first_name || ''} ${contact.last_name || ''}`.trim(),
  };

  // Replace each variable
  Object.entries(replacements).forEach(([key, value]) => {
    // Match both {{firstName}} and {{ firstName }} (with spaces)
    const regex = new RegExp(`{{\\s*${key}\\s*}}`, 'g');
    result = result.replace(regex, value);
  });

  return result;
}

// Extract all variables from a template
export function extractVariables(template: string): string[] {
  if (!template) return [];

  const regex = /{{\\s*([a-zA-Z0-9_]+)\\s*}}/g;
  const matches = template.matchAll(regex);
  const variables = new Set<string>();

  for (const match of matches) {
    variables.add(match[1]);
  }

  return Array.from(variables);
}

// Validate that all variables in template have values
export function validateVariables(
  template: string,
  contact: Record<string, any>
): { valid: boolean; missing: string[] } {
  const variables = extractVariables(template);
  const missing: string[] = [];

  for (const variable of variables) {
    // Map common variable names to contact fields
    const fieldMap: Record<string, string> = {
      firstName: 'first_name',
      lastName: 'last_name',
      fullName: 'first_name', // Check first_name as proxy
    };

    const field = fieldMap[variable] || variable;
    if (!contact[field]) {
      missing.push(variable);
    }
  }

  return {
    valid: missing.length === 0,
    missing,
  };
}
