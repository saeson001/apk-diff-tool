import { createTheme } from '@mui/material';

export const theme = createTheme({
  palette: {
    mode: 'light',
    primary: { main: '#1976d2' },
    secondary: { main: '#00897b' },
    success: { main: '#2e7d32' },
    error: { main: '#c62828' },
    warning: { main: '#f57c00' },
    background: { default: '#f5f7fa', paper: '#ffffff' }
  },
  typography: {
    fontFamily: '"Segoe UI", "Microsoft YaHei", system-ui, -apple-system, sans-serif'
  },
  components: {
    MuiButton: {
      defaultProps: { disableElevation: true }
    },
    MuiPaper: {
      defaultProps: { elevation: 0 }
    }
  }
});
